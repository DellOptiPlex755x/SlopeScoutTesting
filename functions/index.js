const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const axios = require("axios");

// Initialize Firebase Admin
initializeApp();

/**
 * Fetches resort data from the Mountain Powder API
 * @returns {Object} Structured data with lift and trail statuses
 */
async function fetchResortData() {
    try {
        console.log("Fetching resort data from Mountain Powder API");

        // API endpoint discovered through browser inspection
        const apiUrl = "https://mtnpowder.com/feed/v3.json?bearer_token=5pGMqUcRBEG4kmDJyHBPJA9kcynwUrQoGKDxlOLfVdQ&resortId%5B%5D=173&resortId%5B%5D=58&resortId%5B%5D=57";

        // Make the API request
        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36'
            },
            timeout: 10000
        });

        // Log the API response for debugging
        console.log(`API response received: ${response.status}`);
        console.log(`Data length: ${JSON.stringify(response.data).length} characters`);

        // Save raw API response to Firestore for analysis
        await getFirestore().collection("api_responses").add({
            timestamp: new Date().toISOString(),
            status: response.status,
            dataPreview: JSON.stringify(response.data).substring(0, 5000)
        });

        // Initialize our result structure
        const resortData = {
            timestamp: new Date().toISOString(),
            locations: {
                snowValley: {
                    lifts: [],
                    trails: []
                },
                snowSummit: {
                    lifts: [],
                    trails: []
                },
                bearMountain: {
                    lifts: [],
                    trails: []
                }
            }
        };

        // Process the API response
        if (response.data && response.data.resorts) {
            console.log(`Found ${response.data.resorts.length} resorts in API response`);

            // Map resort IDs to our location keys
            const resortIdMap = {
                '173': 'snowValley',  // Adjust these IDs if needed based on the actual data
                '58': 'snowSummit',
                '57': 'bearMountain'
            };

            // Process each resort
            for (const resort of response.data.resorts) {
                console.log(`Processing resort: ${resort.name}`);

                // Determine which resort this is
                let locationKey = null;

                // Try to map by ID first
                if (resort.id && resortIdMap[resort.id]) {
                    locationKey = resortIdMap[resort.id];
                }
                // Fallback to mapping by name
                else if (resort.name) {
                    if (resort.name.includes("Snow Valley")) {
                        locationKey = "snowValley";
                    } else if (resort.name.includes("Snow Summit")) {
                        locationKey = "snowSummit";
                    } else if (resort.name.includes("Bear Mountain")) {
                        locationKey = "bearMountain";
                    }
                }

                if (!locationKey) {
                    console.log(`Could not identify resort: ${resort.name}`);
                    continue;
                }

                console.log(`Mapped to location key: ${locationKey}`);

                // Extract lifts
                if (resort.lifts && Array.isArray(resort.lifts)) {
                    console.log(`Found ${resort.lifts.length} lifts for ${locationKey}`);

                    for (const lift of resort.lifts) {
                        // Make sure we have a name and status
                        if (lift.name) {
                            // Determine status - depending on API structure
                            let status = 'Unknown';

                            // Check different ways the status might be represented
                            if (lift.status) {
                                status = lift.status;
                            } else if (lift.isOpen === true) {
                                status = 'Open';
                            } else if (lift.isOpen === false) {
                                status = 'Closed';
                            } else if (lift.state) {
                                status = lift.state;
                            }

                            console.log(`Adding lift: ${lift.name} - ${status}`);

                            resortData.locations[locationKey].lifts.push({
                                name: lift.name,
                                status: status
                            });
                        }
                    }
                }

                // Extract trails
                if (resort.trails && Array.isArray(resort.trails)) {
                    console.log(`Found ${resort.trails.length} trails for ${locationKey}`);

                    for (const trail of resort.trails) {
                        // Make sure we have a name
                        if (trail.name) {
                            // Determine status - depending on API structure
                            let status = 'Unknown';

                            // Check different ways the status might be represented
                            if (trail.status) {
                                status = trail.status;
                            } else if (trail.isOpen === true) {
                                status = 'Open';
                            } else if (trail.isOpen === false) {
                                status = 'Closed';
                            } else if (trail.state) {
                                status = trail.state;
                            }

                            resortData.locations[locationKey].trails.push({
                                name: trail.name,
                                status: status
                            });
                        }
                    }
                }
            }
        }

        // Verify we have lift data for each resort
        const snowValleyLifts = resortData.locations.snowValley.lifts.length;
        const snowSummitLifts = resortData.locations.snowSummit.lifts.length;
        const bearMountainLifts = resortData.locations.bearMountain.lifts.length;

        console.log(`Lift counts: Snow Valley (${snowValleyLifts}), Snow Summit (${snowSummitLifts}), Bear Mountain (${bearMountainLifts})`);

        // Use fallback data if needed
        if (snowValleyLifts < 5) {
            console.log("Using fallback data for Snow Valley - insufficient data from API");
            resortData.locations.snowValley.lifts = getFallbackSnowValleyLifts();
        }

        if (snowSummitLifts < 3) {
            console.log("Using fallback data for Snow Summit - insufficient data from API");
            resortData.locations.snowSummit.lifts = getFallbackSnowSummitLifts();
        }

        if (bearMountainLifts < 3) {
            console.log("Using fallback data for Bear Mountain - insufficient data from API");
            resortData.locations.bearMountain.lifts = getFallbackBearMountainLifts();
        }

        return resortData;
    } catch (error) {
        console.error("Error fetching resort data from API:", error);

        // Log error to Firestore
        await getFirestore().collection("errors").add({
            timestamp: new Date().toISOString(),
            error: error.toString(),
            stack: error.stack,
            source: "API fetch"
        });

        // Return fallback data on error
        return getFallbackData();
    }
}

/**
 * Get fallback Snow Valley lifts data - UPDATED TO ALL CLOSED
 */
function getFallbackSnowValleyLifts() {
    console.log("Using fallback data for Snow Valley (all closed)");
    return [
        { name: "Chair 1", status: "Closed" },
        { name: "MC 16", status: "Closed" },
        { name: "Chair 2", status: "Closed" },
        { name: "Chair 3", status: "Closed" },
        { name: "Chair 6", status: "Closed" },
        { name: "Chair 8", status: "Closed" },
        { name: "Chair 9", status: "Closed" },
        { name: "Chair 11", status: "Closed" },
        { name: "Chair 12", status: "Closed" },
        { name: "Chair 13", status: "Closed" }
    ];
}

/**
 * Get fallback Snow Summit lifts data
 */
function getFallbackSnowSummitLifts() {
    console.log("Using fallback data for Snow Summit");
    return [
        { name: "Summit Express", status: "Open" },
        { name: "East Mountain Express", status: "Open" },
        { name: "Chair 4", status: "Open" },
        { name: "Chair 6", status: "Open" },
        { name: "Chair 8", status: "Closed" }
    ];
}

/**
 * Get fallback Bear Mountain lifts data
 */
function getFallbackBearMountainLifts() {
    console.log("Using fallback data for Bear Mountain");
    return [
        { name: "Express 1", status: "Open" },
        { name: "Express 2", status: "Open" },
        { name: "Express 9", status: "Open" },
        { name: "Chair 7", status: "Closed" }
    ];
}

/**
 * Get complete fallback data for all resorts
 */
function getFallbackData() {
    return {
        timestamp: new Date().toISOString(),
        locations: {
            snowValley: {
                lifts: getFallbackSnowValleyLifts(),
                trails: [
                    { name: "Westridge", status: "Closed" },
                    { name: "Snow Valley Run", status: "Closed" },
                    { name: "Slide Peak", status: "Closed for Season" },
                    { name: "Rim Trail", status: "Closed" }
                ]
            },
            snowSummit: {
                lifts: getFallbackSnowSummitLifts(),
                trails: [
                    { name: "Miracle Mile", status: "Open" },
                    { name: "Summit Run", status: "Open" },
                    { name: "Log Chute", status: "Limited" },
                    { name: "Westridge", status: "Open" },
                    { name: "Wall Street", status: "Closed" }
                ]
            },
            bearMountain: {
                lifts: getFallbackBearMountainLifts(),
                trails: [
                    { name: "Central Park", status: "Open" },
                    { name: "Park Run", status: "Open" },
                    { name: "Goldmine Mountain", status: "Closed" },
                    { name: "Outlaw", status: "Open" },
                    { name: "Exhibition", status: "Limited" }
                ]
            }
        },
        _meta: {
            source: "fallback",
            reason: "Error in API fetch"
        }
    };
}

// HTTP endpoint to fetch resort data
exports.getResortData = onRequest({
    // Explicitly set CORS options
    cors: {
        origin: ['https://bigbearscrapertest.web.app', 'http://localhost:5000'],
        methods: ['GET', 'OPTIONS'],
        allowedHeaders: ['Content-Type']
    }
}, async (req, res) => {
    try {
        console.log("getResortData function called with query params:", req.query);
        console.log("Origin header:", req.headers.origin);

        // Check if we should force a new fetch
        const forceFetch = req.query.force === "true";

        // If not forcing a fetch, try to get recent data from Firestore
        if (!forceFetch) {
            // Get the latest data from the last 30 minutes
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

            const snapshot = await getFirestore()
                .collection("resortData")
                .orderBy("createdAt", "desc")
                .limit(1)
                .get();

            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                const data = doc.data();

                // Check if data is recent enough
                if (data.createdAt && data.createdAt.toDate() > thirtyMinutesAgo) {
                    console.log("Using recent data from Firestore");

                    // Set cache control headers
                    setCacheControlHeaders(res);

                    return res.status(200).json({
                        ...data,
                        _meta: {
                            source: "cache",
                            age: Math.round((Date.now() - data.createdAt.toDate()) / 1000) + " seconds"
                        }
                    });
                }
            }
        }

        // Either we're forcing a fetch or we don't have recent data
        console.log("Performing new API fetch");
        const data = await fetchResortData();

        // Store in Firestore
        await getFirestore()
            .collection("resortData")
            .add({
                ...data,
                createdAt: new Date(),
                requestInfo: {
                    query: req.query,
                    userAgent: req.headers['user-agent'],
                    origin: req.headers.origin || 'unknown'
                }
            });

        // Set cache control headers
        setCacheControlHeaders(res);

        // Return the data
        return res.status(200).json({
            ...data,
            _meta: {
                source: "fresh_api",
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error("Error getting resort data:", error);

        // Log error to Firestore
        await getFirestore()
            .collection("errors")
            .add({
                timestamp: new Date().toISOString(),
                error: error.toString(),
                stack: error.stack,
                origin: req.headers.origin || 'unknown'
            });

        // Return fallback data on error
        const fallbackData = getFallbackData();

        // Set cache control headers
        setCacheControlHeaders(res);

        return res.status(200).json({
            ...fallbackData,
            _meta: {
                source: "error_fallback",
                error: error.message
            }
        });
    }
});

/**
 * Set cache control headers to prevent caching
 */
function setCacheControlHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
}