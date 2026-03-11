- musicbrainz metadata returns multiple recordings, and information is not always consistent across all of them (eg tags in the results for "All Too Well" by Taylor Swift)

- Code to print list of artists for recordings with multiple artists

  ```ts
  let op = "";
  musicbrainzmetadata.recordings[0]["artist-credit"].forEach((a) => {
    op += a.name + (a.joinphrase ? a.joinphrase : "");
  });

  console.log(op);
  ```
