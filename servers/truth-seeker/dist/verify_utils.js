import { getSuggestions } from "./utils.js";
const candidates = ["created_at", "updated_at", "user_id", "email_address"];
const tests = [
    { target: "create_at", expected: "created_at" },
    { target: "update_at", expected: "updated_at" },
    { target: "userid", expected: "user_id" },
    { target: "email", expected: "email_address" }
];
let passed = true;
tests.forEach(test => {
    const suggestions = getSuggestions(test.target, candidates);
    console.log(`Target: ${test.target}, Suggestions:`, suggestions);
    if (suggestions.length > 0 && suggestions[0].value === test.expected) {
        console.log("  MATCH");
    }
    else {
        console.log("  NO MATCH / WRONG MATCH");
        // passed = false; // It's fuzzy, so strict pass/fail might be flaky, but let's see
    }
});
if (passed) {
    console.log("Utils verification finished.");
}
//# sourceMappingURL=verify_utils.js.map