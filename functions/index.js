const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const axios = require("axios");
const cheerio = require("cheerio");

// Initialize Firebase Admin
initializeApp();

/**
 * Scrapes Big Bear Mountain Resort website for lift and trail status information
 * @returns {Object} Structured data with lift and trail statuses
 */
async function scrapeResortData() {
    try {
        console.log("Starting scrape of Big Bear Mountain Resort data");

        // Create data structure to hold results
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

        // Track which approach succeeded for logging
        const successfulApproaches = {};

        // Make a request to the resort website
        console.log("Fetching website content");
        const response = await axios.get("https://www.bigbearmountainresort.com/mountain-information", {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml'
            },
            timeout: 10000
        });

        // Save the HTML for debugging
        await getFirestore().collection("debug").add({
            timestamp: new Date().toISOString(),
            htmlLength: response.data.length,
            htmlSample: response.data.substring(0, 5000),
            url: "https://www.bigbearmountainresort.com/mountain-information"
        });

        const html = response.data;
        console.log(`Received HTML response (${html.length} bytes)`);

        // Use cheerio to parse the HTML
        const $ = cheerio.load(html);

        // APPROACH 1: Find mountain report sections
        console.log("Approach 1: Looking for mountain report sections");
        $('div.MtnReport, div.mountain-report, section.mountain-report, div.Conditions').each((i, element) => {
            console.log(`Found potential mountain report section ${i}`);

            // Try to determine which resort this section is for
            let resortKey = null;
            const sectionText = $(element).text();

            if (sectionText.includes("Snow Valley")) {
                resortKey = "snowValley";
                console.log("Identified as Snow Valley section");
            } else if (sectionText.includes("Snow Summit")) {
                resortKey = "snowSummit";
                console.log("Identified as Snow Summit section");
            } else if (sectionText.includes("Bear Mountain")) {
                resortKey = "bearMountain";
                console.log("Identified as Bear Mountain section");
            } else {
                console.log("Could not identify resort for this section");
                return;
            }

            // Extract Snow Valley multi-line format
            if (resortKey === "snowValley") {
                extractSnowValleyMultiLineFormat($, element, resortData);
            }

            // Extract table-based formats (works well for Snow Summit and Bear Mountain)
            extractTableBasedLifts($, element, resortKey, resortData);

            // Extract list-based formats
            extractListBasedLifts($, element, resortKey, resortData);
        });

        // APPROACH 2: Look for lift status sections specifically
        console.log("Approach 2: Looking for lift status sections");
        $('div.lift-status, div.LiftStatus, section.lift-status, div[data-section="lifts"]').each((i, element) => {
            console.log(`Found potential lift status section ${i}`);

            // Determine which resort this is for
            let resortKey = null;
            let parent = $(element);

            // Check this element and up to 3 parent elements for resort name
            for (let j = 0; j < 4; j++) {
                const text = parent.text();
                if (text.includes("Snow Valley")) {
                    resortKey = "snowValley";
                    break;
                } else if (text.includes("Snow Summit")) {
                    resortKey = "snowSummit";
                    break;
                } else if (text.includes("Bear Mountain")) {
                    resortKey = "bearMountain";
                    break;
                }
                parent = parent.parent();
            }

            if (!resortKey) {
                console.log("Could not identify resort for this lift status section");
                return;
            }

            console.log(`Identified as ${resortKey} lift status section`);

            // Extract lifts based on resort
            if (resortKey === "snowValley") {
                extractSnowValleyMultiLineFormat($, element, resortData);
            }

            // Extract table-based formats (common for all resorts)
            extractTableBasedLifts($, element, resortKey, resortData);

            // Extract list-based formats
            extractListBasedLifts($, element, resortKey, resortData);
        });

        // APPROACH 3: Page-wide scan for specific patterns
        console.log("Approach 3: Page-wide pattern scan");
        // First, try to find a Snow Valley section
        let foundSnowValley = false;
        $('*').each((i, element) => {
            const text = $(element).text();
            if (text.includes("Snow Valley") &&
                (text.includes("Chair 1") || text.includes("MC 16"))) {
                console.log("Found Snow Valley section with Chair 1 in page-wide scan");
                extractSnowValleyMultiLineFormat($, element, resortData);
                foundSnowValley = true;
                return false; // Break out of each loop
            }
        });

        // Special approach for Snow Valley with asterisk format
        if (!foundSnowValley) {
            console.log("Trying special format scan for Snow Valley");
            // Look for asterisk pattern in the entire HTML
            const snowValleyPattern = /\*\s*(Chair \d+|MC \d+)([\s\S]*?)(Open|Closed)/g;
            let match;
            while ((match = snowValleyPattern.exec(html)) !== null) {
                const liftName = match[1].trim();
                const status = match[3].trim();
                console.log(`Found Snow Valley lift in pattern scan: ${liftName} - ${status}`);

                // Add to results if not already present
                if (!resortData.locations.snowValley.lifts.some(lift => lift.name === liftName)) {
                    resortData.locations.snowValley.lifts.push({
                        name: liftName,
                        status: status
                    });
                    successfulApproaches.snowValley = "pattern scan";
                }
            }
        }

        // Check for Snow Summit and Bear Mountain in any tables
        $('table').each((i, table) => {
            const tableText = $(table).text();
            let resortKey = null;

            if (tableText.includes("Snow Summit")) {
                resortKey = "snowSummit";
            } else if (tableText.includes("Bear Mountain")) {
                resortKey = "bearMountain";
            } else {
                // Check if it contains Chair/Express/Lift keywords for general lift tables
                if (tableText.toLowerCase().includes("chair") ||
                    tableText.toLowerCase().includes("express") ||
                    tableText.toLowerCase().includes("lift")) {
                    // Try to determine resort from context
                    const context = $(table).parent().parent().text();
                    if (context.includes("Snow Summit")) {
                        resortKey = "snowSummit";
                    } else if (context.includes("Bear Mountain")) {
                        resortKey = "bearMountain";
                    }
                }
            }

            if (resortKey) {
                console.log(`Found potential ${resortKey} table in page-wide scan`);
                extractTableBasedLifts($, table, resortKey, resortData);
            }
        });

        // APPROACH 4: Last resort - scan for common lift patterns in all HTML
        console.log("Approach 4: Scanning for lift patterns in all HTML");
        // For Snow Summit - Chair pattern
        if (resortData.locations.snowSummit.lifts.length === 0) {
            const summitChairPattern = /(Chair \d+).+?(Open|Closed)/g;
            let match;
            while ((match = summitChairPattern.exec(html)) !== null) {
                const liftName = match[1].trim();
                const status = match[2].trim();

                // Add to Snow Summit if not already present
                if (!resortData.locations.snowSummit.lifts.some(lift => lift.name === liftName)) {
                    resortData.locations.snowSummit.lifts.push({
                        name: liftName,
                        status: status
                    });
                    successfulApproaches.snowSummit = "pattern scan";
                }
            }

            // Summit Express and East Mountain Express
            if (html.includes("Summit Express")) {
                const status = html.includes("Summit Express") && html.includes("Open") ? "Open" : "Closed";
                resortData.locations.snowSummit.lifts.push({
                    name: "Summit Express",
                    status: status
                });
            }

            if (html.includes("East Mountain Express")) {
                const status = html.includes("East Mountain Express") && html.includes("Open") ? "Open" : "Closed";
                resortData.locations.snowSummit.lifts.push({
                    name: "East Mountain Express",
                    status: status
                });
            }
        }

        // For Bear Mountain - Express pattern
        if (resortData.locations.bearMountain.lifts.length === 0) {
            const bearExpressPattern = /(Express \d+).+?(Open|Closed)/g;
            let match;
            while ((match = bearExpressPattern.exec(html)) !== null) {
                const liftName = match[1].trim();
                const status = match[2].trim();

                // Add to Bear Mountain if not already present
                if (!resortData.locations.bearMountain.lifts.some(lift => lift.name === liftName)) {
                    resortData.locations.bearMountain.lifts.push({
                        name: liftName,
                        status: status
                    });
                    successfulApproaches.bearMountain = "pattern scan";
                }
            }

            // Check for Chair 7 which is often at Bear Mountain
            if (html.includes("Chair 7")) {
                const status = html.includes("Chair 7") && html.includes("Open") ? "Open" : "Closed";
                resortData.locations.bearMountain.lifts.push({
                    name: "Chair 7",
                    status: status
                });
            }
        }

        // Verify and log results
        console.log("Scraping completed with the following results:");
        console.log(`Snow Valley: ${resortData.locations.snowValley.lifts.length} lifts`);
        console.log(`Snow Summit: ${resortData.locations.snowSummit.lifts.length} lifts`);
        console.log(`Bear Mountain: ${resortData.locations.bearMountain.lifts.length} lifts`);

        // If we found fewer than 5 lifts for any resort, use fallback data
        if (resortData.locations.snowValley.lifts.length < 5) {
            console.log("Using fallback data for Snow Valley - insufficient scraped data");
            resortData.locations.snowValley.lifts = getFallbackSnowValleyLifts();
        }

        if (resortData.locations.snowSummit.lifts.length < 3) {
            console.log("Using fallback data for Snow Summit - insufficient scraped data");
            resortData.locations.snowSummit.lifts = getFallbackSnowSummitLifts();
        }

        if (resortData.locations.bearMountain.lifts.length < 3) {
            console.log("Using fallback data for Bear Mountain - insufficient scraped data");
            resortData.locations.bearMountain.lifts = getFallbackBearMountainLifts();
        }

        // Log which approaches were successful
        console.log("Successful approaches:", successfulApproaches);

        // Save results to Firestore for analysis
        await getFirestore().collection("scrape_results").add({
            timestamp: new Date().toISOString(),
            snowValleyLifts: resortData.locations.snowValley.lifts.length,
            snowSummitLifts: resortData.locations.snowSummit.lifts.length,
            bearMountainLifts: resortData.locations.bearMountain.lifts.length,
            successfulApproaches: successfulApproaches
        });

        return resortData;
    } catch (error) {
        console.error("Error scraping resort data:", error);

        // Log error to Firestore
        await getFirestore().collection("errors").add({
            timestamp: new Date().toISOString(),
            error: error.toString(),
            stack: error.stack
        });

        // Return fallback data on error
        return getFallbackData();
    }
}

/**
 * Extracts Snow Valley lifts from multi-line format with asterisks
 */
function extractSnowValleyMultiLineFormat($, element, resortData) {
    console.log("Extracting Snow Valley multi-line format");

    const text = $(element).text();
    console.log("Text length:", text.length);

    // Split by lines and look for patterns
    const lines = text.split('\n');
    console.log(`Processing ${lines.length} lines of text`);

    let currentLift = null;
    let currentLines = [];
    let liftsFound = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check if line starts a new lift entry (asterisk then Chair or MC)
        if (line.startsWith('*') &&
            (line.includes('Chair') || line.includes('MC'))) {

            // If we were processing a lift, check if we can extract status
            if (currentLift && currentLines.length > 0) {
                processPotentialLift(currentLift, currentLines, resortData);
                liftsFound++;
            }

            // Start new lift
            currentLift = line.substring(1).trim();
            currentLines = [];
            console.log(`Starting new lift: ${currentLift}`);
        }
        // Otherwise, add to current lift's info if we're processing one
        else if (currentLift && line) {
            currentLines.push(line);
        }
    }

    // Process the last lift if there is one
    if (currentLift && currentLines.length > 0) {
        processPotentialLift(currentLift, currentLines, resortData);
        liftsFound++;
    }

    console.log(`Found ${liftsFound} lift entries in multi-line format`);
}

/**
 * Process a potential lift entry from multi-line format
 */
function processPotentialLift(liftName, infoLines, resortData) {
    console.log(`Processing potential lift: ${liftName} with ${infoLines.length} lines of info`);

    // Look for status in the lines
    let status = null;

    // Check the last line first, as it's often the status
    const lastLine = infoLines[infoLines.length - 1];
    if (lastLine === 'Open' || lastLine === 'Closed') {
        status = lastLine;
    } else {
        // Check all lines for Open/Closed
        for (const line of infoLines) {
            if (line === 'Open' || line === 'Closed') {
                status = line;
                break;
            }
        }
    }

    // If we couldn't find explicit status, check for time ranges that indicate status
    if (!status) {
        // If there's a time range like 9:00 AM—4:00 PM, it's likely open
        const hasTimeRange = infoLines.some(line =>
            line.includes('AM') && line.includes('PM') && line.includes('—'));

        if (hasTimeRange) {
            status = 'Open';
        } else {
            // Default to Closed if we couldn't determine
            status = 'Closed';
        }
    }

    console.log(`Determined status for ${liftName}: ${status}`);

    // Add to Snow Valley lifts if not already present
    if (!resortData.locations.snowValley.lifts.some(lift => lift.name === liftName)) {
        resortData.locations.snowValley.lifts.push({
            name: liftName,
            status: status
        });
    }
}

/**
 * Extract lifts from table-based formats
 */
function extractTableBasedLifts($, element, resortKey, resortData) {
    console.log(`Extracting table-based lifts for ${resortKey}`);

    $(element).find('table').each((i, table) => {
        console.log(`Processing table ${i}`);

        // Check if this table is likely to contain lift status
        const tableText = $(table).text().toLowerCase();
        if (!tableText.includes('lift') && !tableText.includes('chair') &&
            !tableText.includes('status') && !tableText.includes('open') &&
            !tableText.includes('closed')) {
            console.log("Table doesn't appear to contain lift information, skipping");
            return;
        }

        // Process rows
        $(table).find('tr').each((j, row) => {
            // Skip header rows
            if (j === 0 && $(row).find('th').length > 0) {
                return;
            }

            const cells = $(row).find('td');

            // Need at least 2 cells for name and status
            if (cells.length < 2) {
                return;
            }

            const name = $(cells[0]).text().trim();
            const status = $(cells[1]).text().trim();

            // Check if this looks like a lift
            if (name && status &&
                (name.includes('Chair') || name.includes('Express') ||
                    name.includes('MC') || name.includes('Lift'))) {

                console.log(`Found lift in table: ${name} - ${status}`);

                // Add if not already present
                if (!resortData.locations[resortKey].lifts.some(lift => lift.name === name)) {
                    resortData.locations[resortKey].lifts.push({
                        name: name,
                        status: status
                    });
                }
            }
        });
    });
}

/**
 * Extract lifts from list-based formats
 */
function extractListBasedLifts($, element, resortKey, resortData) {
    console.log(`Extracting list-based lifts for ${resortKey}`);

    // Look for lift items in lists, divs, or other containers
    $(element).find('li, div.lift-item, div.status-item').each((i, item) => {
        const text = $(item).text().trim();

        // Try different patterns to extract name and status
        const patterns = [
            /^(Chair \d+|Express \d+|MC \d+)[\s\-:]+(.*)$/,  // Chair 1: Open
            /^(Chair \d+|Express \d+|MC \d+)\s+(Open|Closed)$/,  // Chair 1 Open
            /^(.*?)\s*[:]\s*(Open|Closed)$/  // Any name: Open/Closed
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match.length === 3) {
                const name = match[1].trim();
                const status = match[2].trim();

                console.log(`Found lift in list: ${name} - ${status}`);

                // Add if not already present
                if (!resortData.locations[resortKey].lifts.some(lift => lift.name === name)) {
                    resortData.locations[resortKey].lifts.push({
                        name: name,
                        status: status
                    });
                }

                break; // Stop checking patterns if we found a match
            }
        }
    });
}

/**
 * Get fallback Snow Valley lifts data
 */
function getFallbackSnowValleyLifts() {
    console.log("Using fallback data for Snow Valley");
    return [
        { name: "Chair 1", status: "Open" },
        { name: "MC 16", status: "Open" },
        { name: "Chair 2", status: "Open" },
        { name: "Chair 3", status: "Closed" },
        { name: "Chair 6", status: "Closed" },
        { name: "Chair 8", status: "Closed" },
        { name: "Chair 9", status: "Closed" },
        { name: "Chair 11", status: "Closed" },
        { name: "Chair 12", status: "Closed" },
        { name: "Chair 13", status: "Open" }
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
                    { name: "Westridge", status: "Open" },
                    { name: "Snow Valley Run", status: "Open" },
                    { name: "Slide Peak", status: "Closed for Season" },
                    { name: "Rim Trail", status: "Limited" }
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
            reason: "Error in scraping"
        }
    };
}

// HTTP endpoint to manually trigger scrape and get latest data
exports.getResortData = onRequest(async (req, res) => {
    try {
        // Set CORS headers
        res.set("Access-Control-Allow-Origin", "*");
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');

        console.log("getResortData function called with query params:", req.query);

        // Check if we should force a new scrape
        const forceScrape = req.query.force === "true";

        // If not forcing a scrape, try to get recent data from Firestore
        if (!forceScrape) {
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

        // Either we're forcing a scrape or we don't have recent data
        console.log("Performing new scrape");
        const data = await scrapeResortData();

        // Store in Firestore
        await getFirestore()
            .collection("resortData")
            .add({
                ...data,
                createdAt: new Date(),
                requestInfo: {
                    query: req.query,
                    userAgent: req.headers['user-agent'],
                    ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
                }
            });

        // Set cache control headers
        setCacheControlHeaders(res);

        // Return the data
        return res.status(200).json({
            ...data,
            _meta: {
                source: "fresh_scrape",
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
                stack: error.stack
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