import { Command } from 'commander';
import { scanCommand } from './commands/scan.js';
import { moveCommand } from './commands/move.js';
import { analyzeCommand } from './commands/analyze.js';
import { impactCommand } from './commands/impact.js';
import { rollbackCommand } from './commands/rollback.js';
import { deleteCommand } from './commands/delete.js';
import { renameCommand } from './commands/rename.js';
import { deadcodeCommand } from './commands/deadcode.js';
import { uiAuditCommand } from './commands/ui-audit.js';
import { depsAuditCommand } from './commands/deps-audit.js';
import { envAuditCommand } from './commands/env-audit.js';
const program = new Command();
program
    .name('refactor')
    .description('Refactoring Runtime — automatic import rewriting, cascade impact analysis, and task generation')
    .version('0.1.0');
program.addCommand(scanCommand);
program.addCommand(moveCommand);
program.addCommand(analyzeCommand);
program.addCommand(impactCommand);
program.addCommand(rollbackCommand);
program.addCommand(deleteCommand);
program.addCommand(renameCommand);
program.addCommand(deadcodeCommand);
program.addCommand(uiAuditCommand);
program.addCommand(depsAuditCommand);
program.addCommand(envAuditCommand);
export { program };
//# sourceMappingURL=index.js.map