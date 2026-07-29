/**
 * validate_runtime_types - Catches type errors that TypeScript misses
 *
 * Detects common runtime errors:
 * - .trim(), .toLowerCase(), etc. on undefined/null
 * - Property access on undefined objects
 * - Missing or wrong-type params/query strings
 * - Database rows with null where code expects values
 *
 * Works by:
 * 1. Analyzing code for dangerous patterns
 * 2. Validating actual data against expected shapes
 * 3. Simulating data flow to catch issues
 */
// ========================================
// DANGEROUS PATTERNS TO DETECT
// ========================================
const DANGEROUS_PATTERNS = [
    {
        name: 'String method on potentially undefined',
        // Matches: something.trim(), variable.toLowerCase(), etc.
        pattern: /(\w+)(?:\.\w+)*\.(trim|toLowerCase|toUpperCase|split|replace|match|slice|substring|substr|charAt|startsWith|endsWith|includes|padStart|padEnd|repeat)\s*\(/g,
        methods: ['trim', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'match', 'slice', 'substring', 'substr', 'charAt', 'startsWith', 'endsWith', 'includes', 'padStart', 'padEnd', 'repeat'],
        type: 'null_method_call',
        severity: 'critical',
        suggestion: 'Use optional chaining (?.) or nullish check before calling string methods',
    },
    {
        name: 'Array method on potentially undefined',
        pattern: /(\w+)(?:\.\w+)*\.(map|filter|find|findIndex|forEach|reduce|some|every|flat|flatMap|sort|reverse|join|includes|indexOf)\s*\(/g,
        methods: ['map', 'filter', 'find', 'findIndex', 'forEach', 'reduce', 'some', 'every', 'flat', 'flatMap', 'sort', 'reverse', 'join', 'includes', 'indexOf'],
        type: 'null_method_call',
        severity: 'critical',
        suggestion: 'Check array exists before calling methods, or use empty array fallback: (arr ?? []).map(...)',
    },
    {
        name: 'Property access without optional chaining',
        // Matches: params.id.something or data.user.name without ?.
        pattern: /(?<![\?\.])\b(\w+)\.(\w+)\.(\w+)(?![\?\.\[])/g,
        type: 'undefined_access',
        severity: 'warning',
        suggestion: 'Consider using optional chaining (a?.b?.c) for nested property access',
    },
    {
        name: 'Direct params/query access',
        // Matches: params.id, query.page, searchParams.get without checks
        pattern: /\b(params|query|searchParams)\s*[.\[]\s*['"]?(\w+)['"]?\s*\]?(?!\s*[?|&])/g,
        type: 'missing_param',
        severity: 'error',
        suggestion: 'Validate params exist and are correct type before use',
    },
    {
        name: 'Database row direct access',
        // Matches: row.field, result.rows[0].field
        pattern: /\b(row|rows\[\d+\]|result\.rows\[\d+\])\s*\.\s*(\w+)(?!\s*[?&|])/g,
        type: 'nullable_db_field',
        severity: 'warning',
        suggestion: 'Database fields can be NULL - check before using or define as nullable in schema',
    },
    {
        name: 'toString on potentially undefined',
        pattern: /(\w+)(?:\.\w+)*\.toString\s*\(/g,
        type: 'null_method_call',
        severity: 'critical',
        suggestion: 'Use String(value) instead of value.toString() - it handles null/undefined',
    },
    {
        name: 'JSON.parse without try-catch',
        pattern: /JSON\.parse\s*\([^)]+\)(?!\s*catch)/g,
        type: 'null_method_call',
        severity: 'error',
        suggestion: 'Wrap JSON.parse in try-catch or use a safe parser',
    },
];
// ========================================
// SAFE PATTERNS (don't flag these)
// ========================================
const SAFE_PATTERNS = [
    /\?\.\w+/, // Optional chaining: obj?.prop
    /\?\.\[/, // Optional chaining: obj?.['prop']
    /\|\|\s*['"`\[\{]/, // Fallback: value || 'default'
    /\?\?\s*['"`\[\{]/, // Nullish coalesce: value ?? 'default'
    /&&\s*\w+\./, // Short circuit: value && value.method()
    /if\s*\(\s*\w+\s*\)/, // If check: if (value) { value.method() }
    /typeof\s+\w+/, // Type check: typeof value !== 'undefined'
    /Array\.isArray/, // Array check: Array.isArray(value)
    /\?\s*\.\s*\w+\s*\(/, // Optional call: value?.method()
    /\(e\)\s*=>/, // Event handler arrow: (e) => e.target.value
    /\(event\)\s*=>/, // Event handler arrow: (event) => event.target.value
    /onChange=\{/, // React onChange handler context
    /onInput=\{/, // React onInput handler context
    /onSubmit=\{/, // React onSubmit handler context
    // Note: Callback patterns removed - they were too broad and caused false negatives.
    // TypeScript's type system should catch issues with typed callback parameters.
];
// ========================================
// REACT/FRAMEWORK SAFE PATTERNS
// These are checked against the ENTIRE file, not just surrounding context
// ========================================
const GLOBAL_SAFE_PATTERNS = [
    // React useState with array initialization
    // Matches: const [items, setItems] = useState([]) or useState<Type[]>([])
    {
        pattern: /const\s+\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*(?:React\.)?useState\s*(?:<[^>]+>)?\s*\(\s*\[\s*\]\s*\)/g,
        extractVar: (match) => match[1],
        reason: 'React useState initialized with empty array'
    },
    // React useState with default value that's an array
    // Matches: const [data, setData] = useState(defaultArray) where default is []
    {
        pattern: /const\s+\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*(?:React\.)?useState\s*\(/g,
        extractVar: (match) => match[1],
        reason: 'React useState (check initialization)'
    },
    // Array destructuring from API response with fallback
    // Matches: const items = data.items || [] or data?.items ?? []
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*[\w.?]+\s*(?:\|\||&&|\?\?)\s*\[\s*\]/g,
        extractVar: (match) => match[1],
        reason: 'Variable initialized with array fallback'
    },
    // Safe array from props or function params with default
    // Matches: function Component({ items = [] })
    {
        pattern: /[({]\s*(\w+)\s*=\s*\[\s*\]/g,
        extractVar: (match) => match[1],
        reason: 'Destructured param with array default'
    },
    // Direct array initialization
    // Matches: const items = [] or let items: Type[] = []
    {
        pattern: /(?:const|let)\s+(\w+)\s*(?::\s*\w+\[\s*\])?\s*=\s*\[\s*\]/g,
        extractVar: (match) => match[1],
        reason: 'Variable initialized as empty array'
    },
    // Variables derived from array methods (filter, map, slice, etc. always return arrays)
    // Matches: const filtered = items.filter(...) or const mapped = arr.map(...)
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*\w+(?:\.\w+)*\.(filter|map|slice|concat|flat|flatMap|sort|reverse|toSorted|toReversed|toSpliced)\s*\(/g,
        extractVar: (match) => match[1],
        reason: 'Variable derived from array method (always returns array)'
    },
    // Array spread into new array
    // Matches: const newItems = [...items] or [...items, newItem]
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*\[\s*\.\.\./g,
        extractVar: (match) => match[1],
        reason: 'Variable initialized with array spread'
    },
    // Object.keys/values/entries always return arrays
    // Matches: const keys = Object.keys(obj)
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*Object\.(keys|values|entries)\s*\(/g,
        extractVar: (match) => match[1],
        reason: 'Variable from Object.keys/values/entries (always returns array)'
    },
    // Array.from always returns an array
    // Matches: const arr = Array.from(iterable)
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*Array\.from\s*\(/g,
        extractVar: (match) => match[1],
        reason: 'Variable from Array.from (always returns array)'
    },
    // React useState with typed array (even without literal [])
    // Matches: const [items, setItems] = useState<Type[]>(anything)
    {
        pattern: /const\s+\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*(?:React\.)?useState\s*<[^>]*\[\s*\]>\s*\(/g,
        extractVar: (match) => match[1],
        reason: 'React useState with array type annotation'
    },
    // Variables from chained array methods (e.g., items.filter(...).sort(...))
    // Matches: const result = arr.filter(...).map(...) or .sort(...) etc.
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*\w+(?:\.\w+)*\.(filter|map|slice|concat|flat|flatMap)\s*\([^)]*\)\s*\.(filter|map|slice|concat|flat|flatMap|sort|reverse)\s*\(/g,
        extractVar: (match) => match[1],
        reason: 'Variable from chained array methods (always returns array)'
    },
    // Multi-line chained methods - look for pattern where variable is assigned then methods follow
    // Matches: const filtered = items\n  .filter(...)\n  .sort(...)
    {
        pattern: /(?:const|let)\s+(\w+)\s*=\s*\w+\s*\n\s*\.(filter|map|slice|sort|concat|flat|flatMap)/g,
        extractVar: (match) => match[1],
        reason: 'Variable from multi-line chained array methods'
    },
];
// ========================================
// VALIDATION FUNCTIONS
// ========================================
/**
 * Extract variables that are safely initialized from the entire code
 */
function extractSafeVariables(code) {
    const safeVars = new Map(); // varName -> reason
    for (const safePattern of GLOBAL_SAFE_PATTERNS) {
        let match;
        const regex = new RegExp(safePattern.pattern.source, safePattern.pattern.flags);
        while ((match = regex.exec(code)) !== null) {
            const varName = safePattern.extractVar(match);
            if (varName && !safeVars.has(varName)) {
                safeVars.set(varName, safePattern.reason);
            }
        }
    }
    return safeVars;
}
/**
 * Analyze code for dangerous patterns that could cause runtime type errors
 */
export function validateCodePatterns(params) {
    const { code, filename } = params;
    const issues = [];
    const lines = code.split('\n');
    // Extract all safely initialized variables from the entire file
    const globalSafeVars = extractSafeVariables(code);
    // Built-in safe variables
    const builtInSafeVars = ['Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Date', 'console', 'process', 'window', 'document'];
    for (const dangerousPattern of DANGEROUS_PATTERNS) {
        let match;
        const regex = new RegExp(dangerousPattern.pattern.source, dangerousPattern.pattern.flags);
        while ((match = regex.exec(code)) !== null) {
            const matchStart = match.index;
            const matchText = match[0];
            const varName = match[1];
            // Find line number
            let lineNum = 1;
            let charCount = 0;
            for (let i = 0; i < lines.length; i++) {
                charCount += lines[i].length + 1; // +1 for newline
                if (charCount > matchStart) {
                    lineNum = i + 1;
                    break;
                }
            }
            const lineContent = lines[lineNum - 1] || '';
            // Check if variable is in built-in safe list
            if (builtInSafeVars.includes(varName)) {
                continue;
            }
            // Check if variable is globally safe (e.g., initialized via useState([]))
            if (globalSafeVars.has(varName)) {
                continue; // Skip - this variable was safely initialized
            }
            // Check if this match is protected by a safe pattern in surrounding context
            const isSafe = SAFE_PATTERNS.some(safePattern => {
                // Check surrounding context (200 chars before and 100 after - callbacks need more lookback)
                const contextStart = Math.max(0, matchStart - 200);
                const contextEnd = Math.min(code.length, matchStart + matchText.length + 100);
                const context = code.slice(contextStart, contextEnd);
                return safePattern.test(context);
            });
            if (!isSafe) {
                issues.push({
                    type: dangerousPattern.type,
                    severity: dangerousPattern.severity,
                    location: {
                        file: filename,
                        line: lineNum,
                        code: lineContent.trim(),
                    },
                    message: `${dangerousPattern.name}: "${matchText.trim()}"`,
                    suggestion: dangerousPattern.suggestion,
                    example: generateFixExample(dangerousPattern.type, matchText),
                });
            }
        }
    }
    // Deduplicate issues by line
    const uniqueIssues = issues.filter((issue, index, self) => index === self.findIndex(i => i.location?.line === issue.location?.line &&
        i.type === issue.type));
    const criticalCount = uniqueIssues.filter(i => i.severity === 'critical').length;
    const errorCount = uniqueIssues.filter(i => i.severity === 'error').length;
    const warningCount = uniqueIssues.filter(i => i.severity === 'warning').length;
    return {
        status: criticalCount > 0 ? 'error' : 'success',
        valid: criticalCount === 0 && errorCount === 0,
        issues: uniqueIssues,
        summary: uniqueIssues.length === 0
            ? 'No dangerous patterns detected'
            : `Found ${criticalCount} critical, ${errorCount} errors, ${warningCount} warnings`,
        recommendations: generateRecommendations(uniqueIssues),
    };
}
/**
 * Validate a database row against expected shape
 */
export function validateDbRow(params) {
    const { row, expectedShape, context } = params;
    const issues = [];
    for (const [field, spec] of Object.entries(expectedShape)) {
        const value = row[field];
        const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        // Check if field exists
        if (!(field in row)) {
            if (!spec.optional) {
                issues.push({
                    type: 'missing_param',
                    severity: 'critical',
                    message: `Missing required field: ${field}`,
                    suggestion: `Add ${field} to your SELECT query or mark as optional`,
                });
            }
            continue;
        }
        // Check for null
        if (value === null || value === undefined) {
            if (!spec.nullable) {
                issues.push({
                    type: 'nullable_db_field',
                    severity: 'error',
                    message: `Field '${field}' is ${value === null ? 'NULL' : 'undefined'} but expected ${spec.type}`,
                    suggestion: `Add null check before using: if (row.${field}) { ... } or use COALESCE in SQL`,
                    example: `const ${field} = row.${field} ?? 'default';`,
                });
            }
            continue;
        }
        // Check type
        const expectedType = spec.type === 'date' ? 'object' : spec.type;
        if (valueType !== expectedType) {
            // Special handling for dates
            if (spec.type === 'date' && (value instanceof Date || !isNaN(Date.parse(value)))) {
                continue;
            }
            issues.push({
                type: 'type_mismatch',
                severity: 'error',
                message: `Field '${field}' is ${valueType} but expected ${spec.type}`,
                suggestion: `Check database column type or add type conversion`,
                example: spec.type === 'number' ? `Number(row.${field})` : `String(row.${field})`,
            });
        }
    }
    return {
        status: issues.some(i => i.severity === 'critical') ? 'error' : 'success',
        valid: issues.length === 0,
        issues,
        summary: issues.length === 0
            ? `Database row ${context ? `(${context}) ` : ''}matches expected shape`
            : `Found ${issues.length} type issue(s) in database row${context ? ` (${context})` : ''}`,
    };
}
/**
 * Validate params (route, query, body) against expected types
 */
export function validateParams(params) {
    const { params: actualParams, expectedParams, source = 'route' } = params;
    const issues = [];
    for (const [param, spec] of Object.entries(expectedParams)) {
        const value = actualParams[param];
        // Check if param exists
        if (value === undefined || value === null || value === '') {
            if (spec.required !== false) {
                issues.push({
                    type: 'missing_param',
                    severity: 'critical',
                    message: `Missing required ${source} param: ${param}`,
                    suggestion: `Check that ${param} is provided in the ${source}`,
                    example: source === 'route'
                        ? `// URL should be: /api/resource/[${param}]`
                        : `// ${source} should include: { ${param}: value }`,
                });
            }
            continue;
        }
        // Validate type
        let isValid = true;
        let actualType = typeof value;
        switch (spec.type) {
            case 'string':
                isValid = typeof value === 'string';
                break;
            case 'number':
                isValid = !isNaN(Number(value));
                actualType = isNaN(Number(value)) ? 'non-numeric string' : 'number';
                break;
            case 'boolean':
                isValid = value === 'true' || value === 'false' || typeof value === 'boolean';
                break;
            case 'uuid':
                isValid = typeof value === 'string' &&
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
                actualType = isValid ? 'uuid' : 'invalid uuid format';
                break;
            case 'slug':
                isValid = typeof value === 'string' && /^[a-z0-9-]+$/i.test(value);
                actualType = isValid ? 'slug' : 'invalid slug format';
                break;
        }
        if (!isValid) {
            issues.push({
                type: 'type_mismatch',
                severity: 'error',
                message: `${source} param '${param}' is ${actualType} but expected ${spec.type}`,
                suggestion: `Validate and convert ${param} before use`,
                example: spec.type === 'number'
                    ? `const ${param} = parseInt(params.${param}, 10); if (isNaN(${param})) throw new Error('Invalid ${param}');`
                    : spec.type === 'uuid'
                        ? `if (!isValidUUID(params.${param})) throw new Error('Invalid ${param}');`
                        : `const ${param} = String(params.${param});`,
            });
        }
    }
    return {
        status: issues.some(i => i.severity === 'critical') ? 'error' : 'success',
        valid: issues.length === 0,
        issues,
        summary: issues.length === 0
            ? `All ${source} params valid`
            : `Found ${issues.length} param issue(s)`,
    };
}
/**
 * Validate data flow from database query to usage
 */
export async function validateDataFlow(pool, params) {
    const { tableName, query, expectedFields } = params;
    const issues = [];
    try {
        // Run query in a transaction that we'll rollback
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // First check table schema
            const schemaResult = await client.query(`
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_name = $1
            `, [tableName]);
            const dbSchema = new Map(schemaResult.rows.map(r => [r.column_name, { type: r.data_type, nullable: r.is_nullable === 'YES' }]));
            // Check each expected field
            for (const [field, spec] of Object.entries(expectedFields)) {
                const dbCol = dbSchema.get(field);
                if (!dbCol) {
                    issues.push({
                        type: 'missing_param',
                        severity: 'critical',
                        message: `Field '${field}' does not exist in table '${tableName}'`,
                        suggestion: `Check column name or add the column to the table`,
                    });
                    continue;
                }
                // Check nullability vs usage
                if (dbCol.nullable && !spec.nullable && spec.usedAs && spec.usedAs.length > 0) {
                    issues.push({
                        type: 'nullable_db_field',
                        severity: 'error',
                        message: `Field '${field}' is NULLABLE in DB but code calls .${spec.usedAs[0]}() on it`,
                        suggestion: `Add null check: row.${field}?.${spec.usedAs[0]}() or COALESCE(${field}, '') in SQL`,
                        example: `const ${field} = row.${field}?.${spec.usedAs[0]}() ?? '';`,
                    });
                }
            }
            // Try to execute the query and check actual data
            try {
                const dataResult = await client.query(query + ' LIMIT 5');
                if (dataResult.rows.length > 0) {
                    const sampleRow = dataResult.rows[0];
                    for (const [field, spec] of Object.entries(expectedFields)) {
                        const value = sampleRow[field];
                        if (value === null && !spec.nullable && spec.usedAs) {
                            issues.push({
                                type: 'nullable_db_field',
                                severity: 'critical',
                                message: `Field '${field}' has NULL value in actual data but code expects to call .${spec.usedAs[0]}()`,
                                suggestion: `Handle NULL case or fix data`,
                            });
                        }
                    }
                }
            }
            catch (queryError) {
                issues.push({
                    type: 'type_mismatch',
                    severity: 'error',
                    message: `Query execution failed: ${queryError instanceof Error ? queryError.message : String(queryError)}`,
                    suggestion: 'Check query syntax and table/column names',
                });
            }
            await client.query('ROLLBACK');
        }
        finally {
            client.release();
        }
    }
    catch (error) {
        issues.push({
            type: 'type_mismatch',
            severity: 'critical',
            message: `Database error: ${error instanceof Error ? error.message : String(error)}`,
            suggestion: 'Check connection string and database access',
        });
    }
    return {
        status: issues.some(i => i.severity === 'critical') ? 'error' : 'success',
        valid: issues.length === 0,
        issues,
        summary: issues.length === 0
            ? 'Data flow validation passed'
            : `Found ${issues.length} potential runtime type error(s)`,
        recommendations: [
            'Use TypeScript strict mode with strictNullChecks',
            'Add runtime validation with Zod for external data',
            'Use ?? and ?. operators for potentially null values',
        ],
    };
}
// ========================================
// BATCH VALIDATION FUNCTIONS
// ========================================
/**
 * Validate multiple code files for dangerous patterns at once
 */
export function validateCodePatternsBatch(params) {
    const { files, stopOnFirstError = false } = params;
    const results = [];
    let passedCount = 0;
    let failedCount = 0;
    const allRecommendations = new Set();
    for (const file of files) {
        const result = validateCodePatterns({
            code: file.code,
            filename: file.path
        });
        const criticalCount = result.issues.filter(i => i.severity === 'critical').length;
        const isValid = result.valid;
        results.push({
            identifier: file.path,
            valid: isValid,
            issueCount: result.issues.length,
            criticalCount,
            issues: result.issues
        });
        if (isValid) {
            passedCount++;
        }
        else {
            failedCount++;
            if (stopOnFirstError)
                break;
        }
        // Collect recommendations
        result.recommendations?.forEach(rec => allRecommendations.add(rec));
    }
    const totalCritical = results.reduce((sum, r) => sum + r.criticalCount, 0);
    const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
    return {
        status: failedCount === 0 ? 'success' : passedCount === 0 ? 'error' : 'partial',
        totalFiles: files.length,
        passedCount,
        failedCount,
        results,
        summary: `Validated ${files.length} files: ${passedCount} passed, ${failedCount} failed. Found ${totalCritical} critical issues, ${totalIssues} total issues.`,
        aggregatedRecommendations: [...allRecommendations]
    };
}
/**
 * Validate multiple database tables against expected schemas at once
 */
export async function validateDbSchemaBatch(pool, params) {
    const { tables } = params;
    const results = [];
    let passedCount = 0;
    let failedCount = 0;
    const allRecommendations = new Set();
    for (const table of tables) {
        const issues = [];
        try {
            const client = await pool.connect();
            try {
                // Get actual schema from information_schema
                const schemaResult = await client.query(`
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = $1
                    ORDER BY ordinal_position
                `, [table.tableName]);
                if (schemaResult.rows.length === 0) {
                    issues.push({
                        type: 'missing_param',
                        severity: 'critical',
                        message: `Table '${table.tableName}' does not exist`,
                        suggestion: 'Check table name spelling or create the table'
                    });
                }
                else {
                    const dbSchema = new Map(schemaResult.rows.map(r => [
                        r.column_name,
                        {
                            type: mapDbType(r.data_type),
                            nullable: r.is_nullable === 'YES'
                        }
                    ]));
                    // Check each expected field
                    for (const [field, spec] of Object.entries(table.expectedShape)) {
                        const dbCol = dbSchema.get(field);
                        if (!dbCol) {
                            if (!spec.optional) {
                                issues.push({
                                    type: 'missing_param',
                                    severity: 'critical',
                                    message: `Column '${field}' does not exist in table '${table.tableName}'`,
                                    suggestion: `Add column to table or mark as optional in expected shape`
                                });
                            }
                            continue;
                        }
                        // Check type compatibility
                        const expectedType = spec.type;
                        const actualType = dbCol.type;
                        if (!areTypesCompatible(expectedType, actualType)) {
                            issues.push({
                                type: 'type_mismatch',
                                severity: 'error',
                                message: `Column '${field}' in '${table.tableName}' is ${actualType} but expected ${expectedType}`,
                                suggestion: `Check column type or update expected shape`
                            });
                        }
                        // Check nullable mismatch
                        if (dbCol.nullable && !spec.nullable) {
                            issues.push({
                                type: 'nullable_db_field',
                                severity: 'warning',
                                message: `Column '${field}' in '${table.tableName}' is NULLABLE but not marked as such`,
                                suggestion: `Add nullable: true to expected shape or add NOT NULL constraint`
                            });
                        }
                    }
                    // Optionally check sample row if query provided
                    if (table.query) {
                        try {
                            const sampleResult = await client.query(table.query + ' LIMIT 1');
                            if (sampleResult.rows.length > 0) {
                                const rowResult = validateDbRow({
                                    row: sampleResult.rows[0],
                                    expectedShape: table.expectedShape,
                                    context: table.tableName
                                });
                                issues.push(...rowResult.issues);
                            }
                        }
                        catch (queryError) {
                            issues.push({
                                type: 'type_mismatch',
                                severity: 'warning',
                                message: `Sample query failed for '${table.tableName}': ${queryError instanceof Error ? queryError.message : String(queryError)}`,
                                suggestion: 'Check query syntax'
                            });
                        }
                    }
                }
            }
            finally {
                client.release();
            }
        }
        catch (error) {
            issues.push({
                type: 'type_mismatch',
                severity: 'critical',
                message: `Database error for '${table.tableName}': ${error instanceof Error ? error.message : String(error)}`,
                suggestion: 'Check database connection'
            });
        }
        const criticalCount = issues.filter(i => i.severity === 'critical').length;
        const isValid = criticalCount === 0 && issues.filter(i => i.severity === 'error').length === 0;
        results.push({
            identifier: table.tableName,
            valid: isValid,
            issueCount: issues.length,
            criticalCount,
            issues
        });
        if (isValid) {
            passedCount++;
        }
        else {
            failedCount++;
        }
        // Collect recommendations
        if (issues.some(i => i.type === 'nullable_db_field')) {
            allRecommendations.add('Review database schema for nullable columns');
            allRecommendations.add('Use COALESCE in SQL or null checks in code');
        }
        if (issues.some(i => i.type === 'type_mismatch')) {
            allRecommendations.add('Ensure code types match database column types');
        }
    }
    const totalCritical = results.reduce((sum, r) => sum + r.criticalCount, 0);
    const totalIssues = results.reduce((sum, r) => sum + r.issueCount, 0);
    return {
        status: failedCount === 0 ? 'success' : passedCount === 0 ? 'error' : 'partial',
        totalTables: tables.length,
        passedCount,
        failedCount,
        results,
        summary: `Validated ${tables.length} tables: ${passedCount} passed, ${failedCount} failed. Found ${totalCritical} critical issues, ${totalIssues} total issues.`,
        aggregatedRecommendations: [...allRecommendations]
    };
}
/**
 * Map PostgreSQL data types to our simplified types
 */
function mapDbType(pgType) {
    const typeMap = {
        'integer': 'number',
        'bigint': 'number',
        'smallint': 'number',
        'numeric': 'number',
        'real': 'number',
        'double precision': 'number',
        'character varying': 'string',
        'varchar': 'string',
        'character': 'string',
        'char': 'string',
        'text': 'string',
        'uuid': 'string',
        'boolean': 'boolean',
        'json': 'object',
        'jsonb': 'object',
        'ARRAY': 'array',
        'timestamp without time zone': 'date',
        'timestamp with time zone': 'date',
        'date': 'date',
        'time': 'string'
    };
    return typeMap[pgType] || pgType;
}
/**
 * Check if expected and actual types are compatible
 */
function areTypesCompatible(expected, actual) {
    if (expected === actual)
        return true;
    // String types are flexible
    if (expected === 'string' && ['string', 'uuid', 'text'].includes(actual))
        return true;
    // Number types are flexible
    if (expected === 'number' && ['number', 'integer', 'bigint'].includes(actual))
        return true;
    return false;
}
// ========================================
// HELPER FUNCTIONS
// ========================================
function generateFixExample(type, matchText) {
    const varMatch = matchText.match(/^(\w+)/);
    const varName = varMatch ? varMatch[1] : 'value';
    const methodMatch = matchText.match(/\.(\w+)\s*\(/);
    const methodName = methodMatch ? methodMatch[1] : 'method';
    switch (type) {
        case 'null_method_call':
            return `// Before (unsafe):\n${matchText}\n\n// After (safe):\n${varName}?.${methodName}() ?? ''`;
        case 'undefined_access':
            return `// Before (unsafe):\n${matchText}\n\n// After (safe):\n${varName}?.nested?.property`;
        case 'missing_param':
            return `// Add validation:\nif (!params.${varName}) {\n  throw new Error('Missing required param: ${varName}');\n}`;
        case 'nullable_db_field':
            return `// Before (unsafe):\nrow.${varName}.trim()\n\n// After (safe):\nrow.${varName}?.trim() ?? ''`;
        default:
            return '';
    }
}
function generateRecommendations(issues) {
    const recs = [];
    const types = new Set(issues.map(i => i.type));
    if (types.has('null_method_call')) {
        recs.push('Enable strictNullChecks in tsconfig.json');
        recs.push('Use optional chaining (?.) before method calls');
    }
    if (types.has('undefined_access')) {
        recs.push('Use optional chaining for nested property access');
        recs.push('Consider using a validation library like Zod');
    }
    if (types.has('missing_param')) {
        recs.push('Add param validation at route handler entry points');
        recs.push('Use Zod schemas for request validation');
    }
    if (types.has('nullable_db_field')) {
        recs.push('Review database schema for nullable columns');
        recs.push('Use COALESCE in SQL or null checks in code');
    }
    return [...new Set(recs)];
}
//# sourceMappingURL=validate_runtime_types.js.map