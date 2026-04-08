April 8, 2026

to keep the server portable and to try to avoid vps costs, I'm running the server on an old android phone with about 8gb of ram. I'm using [termux](https://termux.com/) for the terminal, and proot to access a full linux distribution on it (debian, but considering switching to alpine, which is smaller and faster).

I had to start using proot because bun does not support termux, and I wanted to use bun for the server. I also had to install node and npm in the proot environment, since bun was running into issues with lifecycle scripts on proot/debian during install, but npm works fine.

also installed other basic reqs like ffmpeg and yt-dlp.

next steps:

- move ingest to a separate process
- prepare my Bun server for production
- set up hook to auto deploy + ci/cd, maybe using github actions or something similar, to make it easier to update the server when I make changes.
