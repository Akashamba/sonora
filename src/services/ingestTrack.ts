import { queryMatches } from "~/server/db/queries/queryTrackMatches";
import { addNewTrack } from "~/server/db/transactions/addNewTrack";
import { sanitizeFileName } from "~/utils/audioPath";
import { downloadWithRetry } from "~/utils/fetchM4a";
import {
  extractRecordingAndRelease,
  fetchMusicBrainzMetadata,
  fetchYtMetadata,
  getAudioLengthMs,
  parseYouTubeUrl,
} from "~/utils/metadata-utils";

// for a given url:
// - fetch metadata from youtube
// - Looks up high quality metadata from musicbrainz. use fallback data if not available
// - check if already in db, if not download
// - write to db
export async function ingestTrack(url: string) {
  try {
    // parse url to confirm validity and extract id
    const [youtubeId, youtubeUrl] = parseYouTubeUrl(url);

    // Get metadata from YouTube
    console.log("Fetching metadata from YouTube");
    const ytMetadata = await fetchYtMetadata(youtubeUrl);

    // Get metadata from MusicBrainz
    console.log("Extracting data from musicbrainz");
    const musicbrainzmetadata = await fetchMusicBrainzMetadata(ytMetadata);

    // Check if track already exists
    const matches = await queryMatches(
      youtubeId,
      musicbrainzmetadata.recordings[0].id ?? "",
    );
    if (matches.length > 0) {
      console.log("Song already exists in db");
      return;
    }

    // Extract recording and release information with fallback
    const [recording, release] =
      extractRecordingAndRelease(musicbrainzmetadata);

    // If not, download track
    const filePath = `audio/${sanitizeFileName(recording.title)}.m4a`;
    try {
      await downloadWithRetry(youtubeUrl, filePath);
      console.log("Download complete");
    } catch (err) {
      throw new Error(`Download failed: ${(err as Error).message}`);
    }

    // Write to db
    console.log("Writing track info to database");
    await addNewTrack({
      release: release,
      recording: {
        ...recording,
        length: recording.length ?? getAudioLengthMs(filePath) ?? 0,
      },
      youtubeId: youtubeId,
      filePath: filePath,
    });

    console.log("Track info inserted successfully");
  } catch (err) {
    console.error("Track ingestion failed", err);
    throw err;
  }
}
