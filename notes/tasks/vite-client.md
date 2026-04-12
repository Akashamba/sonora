- [x] set up vite project
- [x] move things from root to server
- [x] new root package.json with workspaces and scritps (dev:server, dev:web, build:server, build:web)
- [x] ensure node_modules, gitignore, etc are integreated

- [x] vite proxy to ensure client talks to server in dev (to avoid CORS issues)
- [x] ensure vite app can make requests to server in dev (without CORS issues)
- [x] test everything works in dev

- [x] build vite app (where does dist go? server/dist?)
- [x] ensure server can serve the built client app in production (vite dev server for dev does not need to be served by the server, but in production we need to serve the built client app)
- [x] ensure csr works from client in production
- [x] ensure client can make requests to server in production without CORS issues

- [x] make audio component that can switch songs in the background with two players

- [x] pull on OP6 and test in production
