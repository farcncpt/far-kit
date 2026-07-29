export async function GET(req) {
    return new Response(JSON.stringify({
        id: 123,
        name: "Test User",
        email: "test@example.com",
        isActive: true
    }), {
        headers: { "Content-Type": "application/json" }
    });
}
export async function POST(req) {
    const body = await req.json();
    return new Response(JSON.stringify({
        received: body,
        status: "created",
        timestamp: new Date().toISOString()
    }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
    });
}
//# sourceMappingURL=mock_json_route.js.map