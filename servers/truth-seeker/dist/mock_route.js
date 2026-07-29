export async function POST(req) {
    const body = await req.json();
    const messages = body.messages;
    const lastMessage = messages[messages.length - 1];
    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            // Simulate Vercel AI SDK Data Stream
            // 0:"text"
            controller.enqueue(encoder.encode('0:"Hello, "'));
            controller.enqueue(encoder.encode('0:"world!"'));
            // Simulate tool call if requested (simple text for now)
            if (lastMessage.content.includes("tool")) {
                // 9: tool call (simplified for test)
                // controller.enqueue(encoder.encode('9:{"toolCallId":"call_1","toolName":"my_tool","args":{"arg":"val"}}'));
            }
            controller.close();
        }
    });
    return new Response(stream, {
        headers: { 'Content-Type': 'text/plain' }
    });
}
//# sourceMappingURL=mock_route.js.map