import fs from 'node:fs';
import path from 'node:path';

import Handlebars from 'handlebars';

const templatesDir = path.join(__dirname, '..', '..', 'modules', 'notifications', 'templates');
const compiledCache = new Map<string, Handlebars.TemplateDelegate>();

export function renderTemplate(name: string, data: Record<string, unknown> = {}): string {
  let compiled = compiledCache.get(name);

  if (!compiled) {
    const filePath = path.join(templatesDir, `${name}.hbs`);
    const source = fs.readFileSync(filePath, 'utf-8');
    compiled = Handlebars.compile(source);
    compiledCache.set(name, compiled);
  }

  return compiled(data);
}
