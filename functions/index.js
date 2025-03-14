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

        // Make a request to the resort website
        const response = await axios.get("https://www.bigbearmountainresort.com/mountain-information");
        const html = response.data;

        // Use cheerio to parse the HTML
        const $ = cheerio.load(html);

        // Initialize an object to store the data
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

        // Define our target locations
        const locations = [
            { name: "Snow Valley", key: "snowValley" },
            { name: "Snow Summit", key: "snowSummit" },
            { name: "Bear Mountain", key: "bearMountain" }
        ];

        // Look for lift status information by location
        $(".MtnReportLiftStatus").each((i, element) => {
            // Find the location this section belongs to
            let locationKey = null;
            for (const location of locations) {
                if ($(element).text().includes(location.name)) {
                    locationKey = location.key;
                    break;
                }
            }

            if (!locationKey) return;

            // Find the lift items
            $(element).find(".InlineItem, .lift-item, tr").each((j, liftElement) => {
                // Try to extract name and status
                let name = $(liftElement).find(".name, .lift-name, td:first-child").text().trim();
                let status = $(liftElement).find(".status, .lift-status, td:nth-child(2)").text().trim();

                // If we couldn't find structured elements, try to parse the text
                if (!name || !status) {
                    const text = $(liftElement).text().trim();
                    const match = text.match(/^(.*?)\s*[-:]\s*(.*)$/);

                    if (match && match.length === 3) {
                        name = match[1].trim();
                        status = match[2].trim();
                    }
                }

                // Add to our data structure if we found valid info
                if (name && status) {
                    resortData.locations[locationKey].lifts.push({ name, status });
                }
            });
        });

        // Look for trail status information by location
        $(".MtnReportTrailStatus, .TrailStatusSection").each((i, element) => {
            // Find the location this section belongs to
            let locationKey = null;
            for (const location of locations) {
                if ($(element).text().includes(location.name)) {
                    locationKey = location.key;
                    break;
                }
            }

            if (!locationKey) return;

            // Find the trail items
            $(element).find(".InlineItem, .trail-item, tr").each((j, trailElement) => {
                // Try to extract name and status
                let name = $(trailElement).find(".name, .trail-name, td:first-child").text().trim();
                let status = $(trailElement).find(".status, .trail-status, td:nth-child(2)").text().trim();

                // If we couldn't find structured elements, try to parse the text
                if (!name || !status) {
                    const text = $(trailElement).text().trim();
                    const match = text.match(/^(.*?)\s*[-:]\s*(.*)$/);

                    if (match && match.length === 3) {
                        name = match[1].trim();
                        status = match[2].trim();
                    }
                }

                // Add to our data structure if we found valid info
                if (name && status) {
                    resortData.locations[locationKey].trails.push({ name, status });
                }
            });
        });

        // If we still don't have data, try a more general approach
        if (!Object.values(resortData.locations).some(loc => loc.lifts.length > 0 || loc.trails.length > 0)) {
            console.log("No data found using specific selectors, trying fallback approach");

            // Look for tables that might contain status information
            $("table").each((i, table) => {
                const tableText = $(table).text().toLowerCase();

                // Determine which location this table is for
                let locationKey = null;
                for (const location of locations) {
                    if (tableText.includes(location.name.toLowerCase())) {
                        locationKey = location.key;
                        break;
                    }
                }

                if (!locationKey) return;

                // Determine if this is a lift or trail table
                const isLiftTable = tableText.includes("lift") || tableText.includes("chair");
                const isTrailTable = tableText.includes("trail") || tableText.includes("run");

                if (!isLiftTable && !isTrailTable) return;

                // Extract row data
                $(table).find("tr").each((j, row) => {
                    if (j === 0) return; // Skip header row

                    const cols = $(row).find("td");
                    if (cols.length < 2) return;

                    const name = $(cols[0]).text().trim();
                    const status = $(cols[1]).text().trim();

                    if (!name || !status) return;

                    if (isLiftTable) {
                        resortData.locations[locationKey].lifts.push({ name, status });
                    } else if (isTrailTable) {
                        resortData.locations[locationKey].trails.push({ name, status });
                    }
                });
            });
        }

        console.log("Scrape completed successfully");
        return resortData;
    } catch (error) {
        console.error("Error scraping resort data:", error);
        throw error;
    }
}

// HTTP endpoint to manually trigger scrape and get latest data
exports.getResortData = onRequest(async (req, res) => {
    try {
        // Set CORS headers
        res.set("Access-Control-Allow-Origin", "*");

        // Check if we should force a new scrape
        const forceScrape = req.query.force === "true";

        if (forceScrape) {
            // Scrape new data
            const data = await scrapeResortData();

            // Store in Firestore
            await getFirestore()
                .collection("resortData")
                .add({
                    ...data,
                    createdAt: new Date()
                });

            return res.status(200).json(data);
        } else {
            // Get the latest data from Firestore
            const snapshot = await getFirestore()
                .collection("resortData")
                .orderBy("createdAt", "desc")
                .limit(1)
                .get();

            if (snapshot.empty) {
                // No data available, perform a scrape
                const data = await scrapeResortData();

                // Store in Firestore
                await getFirestore()
                    .collection("resortData")
                    .add({
                        ...data,
                        createdAt: new Date()
                    });

                return res.status(200).json(data);
            }

            // Return the latest data
            return res.status(200).json(snapshot.docs[0].data());
        }
    } catch (error) {
        console.error("Error getting resort data:", error);
        return res.status(500).json({ error: "Failed to get resort data" });
    }
});