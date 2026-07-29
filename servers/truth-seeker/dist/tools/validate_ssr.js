import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
const execAsync = promisify(exec);
/**
 * Validates server-side rendering by directly invoking Next.js pages or components.
 * Supports both HTTP requests and direct component invocation (bypass).
 *
 * @param input - Configuration for SSR validation
 * @returns Validation result with render time, content matches, and metadata validation
 */
export async function validateSSRRendering(input) {
    const startTime = Date.now();
    // HTTP Mode
    if (input.url) {
        return await validateSSRHTTP(input);
    }
    // Direct Mode (HTTP Bypass)
    if (input.pagePath || input.componentPath) {
        return await validateSSRDirect(input);
    }
    throw new Error("Either 'url' or 'pagePath'/'componentPath' must be provided");
}
async function validateSSRHTTP(input) {
    const startTime = Date.now();
    try {
        const response = await fetch(input.url, {
            headers: input.headers || {}
        });
        const html = await response.text();
        const renderTime = Date.now() - startTime;
        // Validate content
        const contentMatches = {
            found: [],
            missing: []
        };
        if (input.expectedContent) {
            for (const content of input.expectedContent) {
                if (html.includes(content)) {
                    contentMatches.found.push(content);
                }
                else {
                    contentMatches.missing.push(content);
                }
            }
        }
        // Validate metadata
        let metadataValid = true;
        if (input.expectedMetadata) {
            if (input.expectedMetadata.title) {
                const titleMatch = html.match(/<title>(.*?)<\/title>/);
                metadataValid = !!(titleMatch && titleMatch[1] === input.expectedMetadata.title);
            }
        }
        return {
            status: contentMatches.missing.length === 0 ? "success" : "error",
            mode: "http",
            renderTime,
            contentMatches,
            metadataValid,
            hydrationErrors: [],
            summary: contentMatches.missing.length === 0
                ? "SSR rendering successful, all content present"
                : `Missing content: ${contentMatches.missing.join(", ")}`
        };
    }
    catch (error) {
        return {
            status: "error",
            mode: "http",
            message: error instanceof Error ? error.message : String(error),
            hint: "Check URL and ensure server is running"
        };
    }
}
async function validateSSRDirect(input) {
    const startTime = Date.now();
    try {
        // Create temporary script to render component
        const tempScriptPath = path.join(process.cwd(), `.mcp-ssr-temp-${Date.now()}.mts`);
        const componentPath = input.pagePath || input.componentPath;
        const absolutePath = path.resolve(componentPath);
        const scriptContent = `
import { renderToString } from 'react-dom/server';
import PageComponent from '${absolutePath.replace(/\\/g, '\\\\')}';

const params = ${JSON.stringify(input.params || {})};
const searchParams = ${JSON.stringify(input.searchParams || {})};

async function renderPage() {
  try {
    // @ts-ignore
    const element = await PageComponent({ params, searchParams });
    const html = renderToString(element);

    console.log(JSON.stringify({
      success: true,
      html,
      props: { params, searchParams }
    }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
  }
}

renderPage();
`;
        await fs.writeFile(tempScriptPath, scriptContent, 'utf-8');
        // Execute temporary script
        const { stdout, stderr } = await execAsync(`npx tsx ${tempScriptPath}`);
        // Clean up
        await fs.unlink(tempScriptPath).catch(() => { });
        const result = JSON.parse(stdout.trim());
        const renderTime = Date.now() - startTime;
        if (!result.success) {
            return {
                status: "error",
                mode: "direct",
                message: result.error,
                hint: "Check component path and ensure it exports a valid React component"
            };
        }
        // Validate content
        const contentMatches = {
            found: [],
            missing: []
        };
        if (input.expectedContent) {
            for (const content of input.expectedContent) {
                if (result.html.includes(content)) {
                    contentMatches.found.push(content);
                }
                else {
                    contentMatches.missing.push(content);
                }
            }
        }
        // Validate metadata (extract from HTML)
        let metadataValid = true;
        if (input.expectedMetadata?.title) {
            const titleMatch = result.html.match(/<title>(.*?)<\/title>/);
            metadataValid = !!(titleMatch && titleMatch[1] === input.expectedMetadata.title);
        }
        return {
            status: contentMatches.missing.length === 0 ? "success" : "error",
            mode: "direct",
            renderTime,
            component: path.basename(componentPath),
            contentMatches,
            metadataValid,
            props: result.props,
            summary: contentMatches.missing.length === 0
                ? "Direct RSC rendering successful"
                : `Missing content: ${contentMatches.missing.join(", ")}`
        };
    }
    catch (error) {
        return {
            status: "error",
            mode: "direct",
            message: error instanceof Error ? error.message : String(error),
            hint: "Check component path and ensure dependencies are installed"
        };
    }
}
//# sourceMappingURL=validate_ssr.js.map