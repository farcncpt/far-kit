import { validateAgentConversation } from './tools/validate_conversation.js';
async function run() {
    console.log("Starting LMS Chat Debug...");
    try {
        const result = await validateAgentConversation({
            url: 'http://localhost:3000/api/chat',
            protocol: 'vercel-ai-sdk-data-stream',
            conversation: [
                {
                    role: 'user',
                    content: 'Create a course called "Python 101"',
                    expect: {
                    // We just want to see if it crashes first
                    }
                }
            ]
        });
        console.log("Debug Result:", JSON.stringify(result, null, 2));
    }
    catch (e) {
        console.error("Script failed:", e);
    }
}
run();
//# sourceMappingURL=debug_lms_chat.js.map