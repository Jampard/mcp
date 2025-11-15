import { promises as fs } from 'fs';
import path from 'path';

import { getProjectContext } from '../project-context.js';

interface CachedContent {
    content: string;
    timestamp: number;
}

interface Section {
    title: string;
    level: number;
    content: string;
    startLine: number;
    endLine: number;
}

interface PaginationResult {
    content: string;
    metadata: {
        totalSections?: number;
        currentSection?: string;
        totalPages?: number;
        currentPage?: number;
        pageSize?: number;
    };
}

export class VendureDocsService {
    private static readonly VENDURE_DOCS_BASE_URL = 'https://docs.vendure.io';
    private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    private static readonly CACHE_DIR = '.vendure-docs-cache';

    private llmsTxtCache: CachedContent | null = null;
    private llmsFullTxtCache: CachedContent | null = null;

    async getLlmsTxt(): Promise<string> {
        return this.getDocumentContent('llms.txt', 'llms');
    }

    async getLlmsFullTxt(): Promise<string> {
        return this.getDocumentContent('llms-full.txt', 'full');
    }

    /**
     * Get paginated documentation content
     * @param type - Documentation type ('full' or 'standard')
     * @param options - Pagination options
     * @returns Paginated content with metadata
     */
    async getPaginatedDocs(
        type: 'full' | 'standard',
        options?: {
            section?: string;
            page?: number;
            pageSize?: number;
        },
    ): Promise<PaginationResult> {
        const fullContent = type === 'full' ? await this.getLlmsFullTxt() : await this.getLlmsTxt();

        // If no pagination options, return table of contents
        if (!options?.section && !options?.page) {
            return this.getTableOfContents(fullContent);
        }

        // Section-based pagination
        if (options.section) {
            return this.getSection(fullContent, options.section);
        }

        // Numeric pagination
        if (options.page !== undefined) {
            return this.getPage(fullContent, options.page, options.pageSize || 5000);
        }

        // Fallback to full content (shouldn't reach here)
        return {
            content: fullContent,
            metadata: {},
        };
    }

    /**
     * Parse markdown content into sections
     */
    private parseSections(content: string): Section[] {
        const lines = content.split('\n');
        const sections: Section[] = [];
        let currentSection: Section | undefined;

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

            if (headerMatch) {
                // Save previous section
                if (currentSection !== undefined) {
                    currentSection.endLine = index - 1;
                    sections.push(currentSection);
                }

                // Start new section
                currentSection = {
                    title: headerMatch[2].trim(),
                    level: headerMatch[1].length,
                    content: line + '\n',
                    startLine: index,
                    endLine: index,
                };
            } else if (currentSection !== undefined) {
                currentSection.content += line + '\n';
            }
        }

        // Save last section
        if (currentSection !== undefined) {
            currentSection.endLine = lines.length - 1;
            sections.push(currentSection);
        }

        return sections;
    }

    /**
     * Get table of contents
     */
    private getTableOfContents(content: string): PaginationResult {
        const sections = this.parseSections(content);

        let toc = '# Vendure Documentation - Table of Contents\n\n';
        toc += 'Use the `section` parameter to retrieve specific sections.\n\n';
        toc += '## Available Sections\n\n';

        sections.forEach((section, index) => {
            const indent = '  '.repeat(section.level - 1);
            toc += `${indent}${index + 1}. ${section.title}\n`;
        });

        toc += '\n## Usage Examples\n\n';
        toc += '- Get specific section: `{ "type": "standard", "section": "Core Concepts" }`\n';
        toc += '- Get page 1: `{ "type": "standard", "page": 1, "pageSize": 5000 }`\n';

        return {
            content: toc,
            metadata: {
                totalSections: sections.length,
            },
        };
    }

    /**
     * Get a specific section by title
     */
    private getSection(content: string, sectionTitle: string): PaginationResult {
        const sections = this.parseSections(content);

        // Find section (case-insensitive, partial match)
        const section = sections.find(s => s.title.toLowerCase().includes(sectionTitle.toLowerCase()));

        if (!section) {
            const availableSections = sections.map(s => s.title).join('\n- ');
            return {
                content: `# Section Not Found\n\nCould not find section matching: "${sectionTitle}"\n\n## Available sections:\n- ${availableSections}`,
                metadata: {
                    totalSections: sections.length,
                },
            };
        }

        return {
            content: section.content,
            metadata: {
                totalSections: sections.length,
                currentSection: section.title,
            },
        };
    }

    /**
     * Get a specific page with numeric pagination
     */
    private getPage(content: string, page: number, pageSize: number): PaginationResult {
        const lines = content.split('\n');
        const totalPages = Math.ceil(lines.length / pageSize);

        if (page < 1 || page > totalPages) {
            return {
                content: `# Invalid Page\n\nPage ${page} is out of range. Total pages: ${totalPages}`,
                metadata: {
                    totalPages,
                    pageSize,
                },
            };
        }

        const startLine = (page - 1) * pageSize;
        const endLine = Math.min(startLine + pageSize, lines.length);
        const pageContent = lines.slice(startLine, endLine).join('\n');

        return {
            content: pageContent,
            metadata: {
                totalPages,
                currentPage: page,
                pageSize,
            },
        };
    }

    private async getDocumentContent(filename: string, cacheType: 'llms' | 'full'): Promise<string> {
        const cache = cacheType === 'llms' ? this.llmsTxtCache : this.llmsFullTxtCache;

        // Check if we have valid cached content
        if (cache && this.isCacheValid(cache)) {
            return cache.content;
        }

        try {
            // Try to fetch from web
            const content = await this.fetchFromWeb(filename);

            // For llms-full.txt, enhance with project context before caching
            const contentToCache = cacheType === 'full' ? this.enhanceWithProjectContext(content) : content;

            // Update cache
            const cachedContent: CachedContent = {
                content: contentToCache,
                timestamp: Date.now(),
            };

            if (cacheType === 'llms') {
                this.llmsTxtCache = cachedContent;
            } else {
                this.llmsFullTxtCache = cachedContent;
            }

            // Persist to disk cache
            await this.saveToDiskCache(filename, cachedContent);

            return contentToCache;
        } catch (error) {
            console.warn(`Failed to fetch ${filename} from web, trying disk cache:`, error);

            // Try disk cache
            try {
                const diskCached = await this.loadFromDiskCache(filename);
                if (diskCached) {
                    if (cacheType === 'llms') {
                        this.llmsTxtCache = diskCached;
                    } else {
                        this.llmsFullTxtCache = diskCached;
                    }
                    return diskCached.content;
                }
            } catch (diskError) {
                console.warn(`Failed to load ${filename} from disk cache:`, diskError);
            }

            // Fall back to bundled content
            console.warn(`Using fallback content for ${filename}`);
            const fallbackContent = this.getFallbackContent(filename);
            return cacheType === 'full' ? this.enhanceWithProjectContext(fallbackContent) : fallbackContent;
        }
    }

    private async fetchFromWeb(filename: string): Promise<string> {
        const url = `${VendureDocsService.VENDURE_DOCS_BASE_URL}/${filename}`;

        // Use Node.js built-in fetch (available in Node.js 18+)
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();
    }

    private isCacheValid(cache: CachedContent): boolean {
        return Date.now() - cache.timestamp < VendureDocsService.CACHE_TTL_MS;
    }

    private async saveToDiskCache(filename: string, cache: CachedContent): Promise<void> {
        try {
            const cacheDir = path.resolve(VendureDocsService.CACHE_DIR);
            await fs.mkdir(cacheDir, { recursive: true });

            const cacheFile = path.join(cacheDir, `${filename}.json`);
            await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf-8');
        } catch (error) {
            // Non-critical error, continue without disk cache
            console.warn('Failed to save to disk cache:', error);
        }
    }

    private async loadFromDiskCache(filename: string): Promise<CachedContent | null> {
        try {
            const cacheFile = path.resolve(VendureDocsService.CACHE_DIR, `${filename}.json`);
            const cacheData = await fs.readFile(cacheFile, 'utf-8');
            const cache: CachedContent = JSON.parse(cacheData);

            if (this.isCacheValid(cache)) {
                return cache;
            }

            // Cache is stale, delete it
            await fs.unlink(cacheFile).catch(() => {
                // Ignore errors
            });
            return null;
        } catch (error) {
            return null;
        }
    }

    private getFallbackContent(filename: string): string {
        if (filename === 'llms.txt') {
            return this.getFallbackLlmsTxt();
        } else if (filename === 'llms-full.txt') {
            return this.getFallbackLlmsFullTxt();
        }
        return `# ${filename}\n\nFallback content - official documentation temporarily unavailable.`;
    }

    private enhanceWithProjectContext(content: string): string {
        try {
            const { projectPath } = getProjectContext();

            // Add project-specific context to the beginning
            const projectContext = `
# Current Project Context
Project Path: ${projectPath}

## Available MCP Tools
- vendure_add: Add plugins, entities, services to your project
- vendure_migrate: Run database migrations
- vendure_analyse: Analyze project structure (tasks: list_plugins, analyze_project_structure, check_vendure_installation, get_database_type)

---

`;

            return projectContext + content;
        } catch (error) {
            // If project context is not available, return content as-is
            return content;
        }
    }

    private getFallbackLlmsTxt(): string {
        return `# Vendure E-commerce Framework

Vendure is a modern, headless e-commerce framework built with TypeScript and Node.js.

## Core Concepts

### Project Structure
- **Entities**: Custom database entities (*.entity.ts)
- **Services**: Business logic services (*.service.ts)
- **Plugins**: Modular extensions (*.plugin.ts)
- **Migrations**: Database schema changes
- **Configuration**: vendure-config.ts file

### CLI Commands
- **vendure add**: Add plugins, entities, services, and other components
- **vendure migrate**: Run database migrations
- **vendure init**: Initialize new Vendure project

### Plugin System
- Plugins extend Vendure functionality
- Can add new GraphQL schema, services, entities
- Support for payment providers, shipping methods, custom fields

### Database Support
- PostgreSQL (recommended)
- MySQL/MariaDB
- SQLite (development)

## Documentation Links

- Main Documentation: https://docs.vendure.io/
- Plugin Development: https://docs.vendure.io/guides/developer-guide/plugins/
- CLI Guide: https://docs.vendure.io/guides/developer-guide/cli/
- API Reference: https://docs.vendure.io/reference/
- GraphQL API: https://docs.vendure.io/graphql-api/
- Configuration: https://docs.vendure.io/reference/vendure-config/

## Best Practices

- Use TypeScript for type safety
- Follow plugin architecture for extensions
- Implement proper error handling
- Use database transactions for data consistency
- Follow security best practices for authentication

For specific implementation details, refer to the comprehensive documentation at docs.vendure.io

Note: This is fallback content. Official documentation may be temporarily unavailable.`;
    }

    private getFallbackLlmsFullTxt(): string {
        return `# Vendure E-commerce Framework - Complete Reference

Vendure is a modern, headless GraphQL-first e-commerce framework built with TypeScript and Node.js.

## Architecture Overview

### Core Components
- **Admin UI**: Angular-based administration interface
- **Shop API**: Customer-facing GraphQL API
- **Admin API**: Administration GraphQL API
- **Worker**: Background job processing
- **Plugin System**: Extensible architecture

### Technology Stack
- TypeScript/Node.js backend
- GraphQL API (using Apollo Server)
- Database: PostgreSQL, MySQL, or SQLite
- ORM: TypeORM for database operations
- Authentication: JWT-based sessions

## CLI Commands Reference

### vendure add
Add components to your Vendure project:
- \`vendure add plugin\`: Add a new plugin
- \`vendure add entity\`: Add a custom entity
- \`vendure add service\`: Add a new service
- \`vendure add job-queue\`: Add job queue functionality
- \`vendure add ui-extension\`: Add Admin UI extensions

### vendure migrate
Database migration management:
- \`vendure migrate\`: Run pending migrations
- \`vendure migrate:revert\`: Revert last migration
- \`vendure migrate:generate\`: Generate new migration

## Documentation Resources

### Primary Resources
- Official Documentation: https://docs.vendure.io/
- Getting Started: https://docs.vendure.io/guides/getting-started/
- Developer Guide: https://docs.vendure.io/guides/developer-guide/
- Plugin Development: https://docs.vendure.io/guides/developer-guide/plugins/
- CLI Reference: https://docs.vendure.io/guides/developer-guide/cli/

### API Documentation
- GraphQL Playground: http://localhost:3000/admin-api (when running)
- Shop API Schema: https://docs.vendure.io/graphql-api/shop/
- Admin API Schema: https://docs.vendure.io/graphql-api/admin/
- TypeScript API: https://docs.vendure.io/reference/

### Community Resources
- GitHub Repository: https://github.com/vendure-ecommerce/vendure
- Discord Community: https://vendure.io/community/
- YouTube Channel: Vendure E-commerce
- Blog: https://vendure.io/blog/

Note: This is fallback content. For the most comprehensive and up-to-date documentation, the service attempts to fetch from docs.vendure.io. If you're seeing this message, the official documentation may be temporarily unavailable.`;
    }
}
