import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { cliCommands } from '@vendure/cli/dist/commands/command-declarations.js';
import { z } from 'zod';
import type { VendureDocsService } from '../utils/vendure-docs-service.js';

import { getProjectContext } from '../project-context.js';
import { commandSchemas } from '../schemas/schema-generator.js';
import { executeMcpOperation } from '../utils/cli-executor.js';
import { convertCamelToSnakeCase, convertToParameterName } from '../utils/command-parser.js';

import { analysisTasks } from './analysis-tasks-declarations.js';

export function registerCliCommandTools(server: McpServer): void {
    for (const command of cliCommands) {
        const commandSchema = commandSchemas[command.name];

        // Register main command
        server.registerTool(
            `vendure_${command.name}`,
            {
                description: command.description,
                ...(command.options &&
                    command.options.length > 0 && { inputSchema: commandSchema.mainCommand.shape }),
            },
            async (args: Record<string, any>) => {
                const { projectPath } = getProjectContext();
                const result = await executeMcpOperation(command.name, args, projectPath);
                return {
                    content: [{ type: 'text' as const, text: result }],
                };
            },
        );

        // Register sub-commands
        if (commandSchema.subCommands) {
            for (const subCommandName of Object.keys(commandSchema.subCommands)) {
                const subCommandSchema = commandSchema.subCommands[subCommandName];
                const subCommandOption = command.options?.find(
                    o => convertToParameterName(o.long) === subCommandName,
                );

                server.registerTool(
                    `vendure_${command.name}_${convertCamelToSnakeCase(subCommandName)}`,
                    {
                        description: `${subCommandOption?.description} (used in "vendure ${command.name}")`,
                        inputSchema: subCommandSchema.shape,
                    },
                    async (args: Record<string, any>) => {
                        const { projectPath } = getProjectContext();
                        // Handle both 'name' and 'value' as the main parameter (in case of naming conflicts)
                        const mainParamValue = args.name ?? args.value;
                        const transformedArgs = { [subCommandName]: mainParamValue, ...args };
                        const result = await executeMcpOperation(command.name, transformedArgs, projectPath);
                        return {
                            content: [{ type: 'text' as const, text: result }],
                        };
                    },
                );
            }
        }
    }
}

export function registerAnalysisTool(server: McpServer): void {
    const taskNames = analysisTasks.map(t => t.name) as [string, ...string[]];
    const taskDescriptions = analysisTasks.map(t => `- ${t.name}: ${t.description}`).join('\n');

    const analysisInputSchema = {
        task: z.enum(taskNames).describe(`The analysis task to run:\n${taskDescriptions}`),
    };

    server.registerTool(
        'vendure_analyse',
        {
            description: 'Run a project analysis task. Specify which analysis to run.',
            inputSchema: analysisInputSchema,
        },
        async ({ task }: { task: string }) => {
            const { projectPath } = getProjectContext();
            const selectedTask = analysisTasks.find(t => t.name === task);
            if (!selectedTask) {
                return {
                    content: [{ type: 'text' as const, text: `Error: Analysis task "${task}" not found.` }],
                };
            }
            const result = selectedTask.handler(projectPath);
            return {
                content: [{ type: 'text' as const, text: result }],
            };
        },
    );
}

export function registerDocTool(server: McpServer, vendureDocsService: VendureDocsService): void {
    const docTypeEnum = z.enum(['full', 'standard']).describe('The type of documentation to retrieve.');

    server.registerTool(
        'vendure_get_docs',
        {
            description:
                'Retrieves Vendure documentation with pagination support. Call without section/page parameters to get table of contents. Use "section" for specific sections or "page" for numeric pagination.',
            inputSchema: {
                type: docTypeEnum,
                section: z
                    .string()
                    .optional()
                    .describe(
                        'Specific section title to retrieve (case-insensitive, partial match supported)',
                    ),
                page: z.number().optional().describe('Page number for numeric pagination (starts at 1)'),
                pageSize: z
                    .number()
                    .optional()
                    .describe('Lines per page for numeric pagination (default: 5000)'),
            },
        },
        async ({
            type,
            section,
            page,
            pageSize,
        }: {
            type: 'full' | 'standard';
            section?: string;
            page?: number;
            pageSize?: number;
        }) => {
            const result = await vendureDocsService.getPaginatedDocs(type, {
                section,
                page,
                pageSize,
            });

            // Format response with metadata
            let responseText = result.content;

            if (Object.keys(result.metadata).length > 0) {
                responseText += '\n\n---\n**Pagination Info:**\n';
                if (result.metadata.totalSections) {
                    responseText += `- Total sections: ${result.metadata.totalSections}\n`;
                }
                if (result.metadata.currentSection) {
                    responseText += `- Current section: ${result.metadata.currentSection}\n`;
                }
                if (result.metadata.totalPages) {
                    responseText += `- Total pages: ${result.metadata.totalPages}\n`;
                }
                if (result.metadata.currentPage) {
                    responseText += `- Current page: ${result.metadata.currentPage}/${result.metadata.totalPages}\n`;
                }
                if (result.metadata.pageSize) {
                    responseText += `- Page size: ${result.metadata.pageSize} lines\n`;
                }
            }

            return {
                content: [{ type: 'text' as const, text: responseText }],
            };
        },
    );
}
