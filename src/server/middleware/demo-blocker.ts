// Middleware to block certain routes for demo purposes

const DEMO = Bun.env.DEMO_MODE === "true";

export function blockInDemo(
  handler: (req: Bun.BunRequest) => Response | Promise<Response>,
) {
  return (req: Bun.BunRequest) => {
    if (DEMO) return new Response("Read-only demo", { status: 403 });
    return handler(req);
  };
}
