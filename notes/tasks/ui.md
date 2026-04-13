- mobile design only for now

- sign in page
- home screen: only top tracks and recent tracks and now playing for first iteration
- now playing screen
  - show track info, play/pause button, progress, queue, like buttons
  - configure navigator with controls for play/pause, next, previous, and progress
  - audio element should stay mounted on any screen of the app (move audio element outside <Routes> and use zustand to store the refs)
- library screen: show albums, liked albums, playlists and liked tracks
  - artists screen: (with library screen) show artists
  - albums screen: (with library screen) show albums and allow users to play albums and add albums to queue
- queue screen: show the queue and allow users to reorder tracks in the queue
- profile screen: show user info and liked tracks
- search screen: allow users to search for tracks, artists, albums, and playlists
- import screen: import songs/playlists with url

# App Structure

- sign in page
- use bottom navigation: home, library, import, search
- now playing should be accessible from anywhere in the app with a floating bottom bar button showing the current track and play/pause button and maybe a progress bar
- back button on top left where applicable (e.g. search screen, library screen, queue screen)
- queue screen should be a full page popover from now playing screen
- profile button on top right of the home screen
- For first version
  - Main Screens
    - home page shows top tracks and recent tracks
    - library page shows 5 albums and 5 artists and two search bars for albums and artists. Clicking on an album or artist takes you to the album/artist page where you can see all songs in the album/artists and play them or add them to queue
    - import page allows users to import songs/playlists with url. as soon as url is added to queue, redirect to home page
    - search page lists all matching tracks
  - Now Playing: should always be mounted so that audio can be played on any screen
    - configure navigator with controls for play/pause, next, previous, and progress
    - full screen should show album cover, track title, artist, and play/pause button, progress bar, queue button
    - small screen should show album cover, track title, artist, and play/pause button and be visible just above the bottom navigation bar
