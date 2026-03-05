import { parseFile } from "music-metadata";

(async () => {
  try {
    const filePath = process.argv[2];

    if (!filePath) {
      console.error("Usage: node script.js <audio-file-path>");
      process.exit(1);
    }

    const metadata = await parseFile(filePath);

    // Output as JSON
    console.log(JSON.stringify(metadata, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
  }
})();
