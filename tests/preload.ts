// Keeps MusicBrainz pacing and retry backoff short in every test. Tests that
// check those timings set their own values.
process.env.MUSICBRAINZ_MIN_INTERVAL_MS = "0";
process.env.MUSICBRAINZ_BACKOFF_BASE_MS = "1";
process.env.COVER_ART_RETRY_DELAYS_MS = "0,0,0,0,0";
