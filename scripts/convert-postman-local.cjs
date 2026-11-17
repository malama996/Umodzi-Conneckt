const fs = require('fs');
const path = require('path');

const collection = JSON.parse(fs.readFileSync('postman/Umodzi-Connect-API.postman_collection.json', 'utf8'));
const environment = JSON.parse(fs.readFileSync('postman/Umodzi-Connect-Local.postman_environment.json', 'utf8'));
const root = path.join('postman', 'collections', 'Umodzi Connect API');

const quote = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;
const safe = (value) => String(value).replace(/[\\/:*?"<>|]/g, '-');
const lines = [];
const add = (line = '') => lines.push(line);

function writeYaml(file, build) {
  lines.length = 0;
  build();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function addScripts(events, indent = '') {
  if (!events?.length) return;
  add(`${indent}scripts:`);
  for (const event of events) {
    add(`${indent}  - type: ${event.listen === 'prerequest' ? 'beforeRequest' : 'afterResponse'}`);
    add(`${indent}    code: |-`);
    for (const codeLine of event.script?.exec ?? []) add(`${indent}      ${codeLine}`);
    add(`${indent}    language: text/javascript`);
  }
}

function addAuth(auth, indent = '') {
  if (!auth) return;
  add(`${indent}auth:`);
  add(`${indent}  type: ${auth.type}`);
  add(`${indent}  credentials:`);
  for (const item of auth[auth.type] ?? []) {
    add(`${indent}    - key: ${quote(item.key)}`);
    add(`${indent}      value: ${quote(item.value)}`);
  }
}

writeYaml(path.join(root, '.resources', 'definition.yaml'), () => {
  add('$kind: collection');
  add(`name: ${quote(collection.info.name)}`);
  add('description: |-');
  for (const line of String(collection.info.description ?? '').split(/\r?\n/)) add(`  ${line}`);
  if (collection.variable?.length) {
    add('variables:');
    for (const variable of collection.variable) {
      add(`  - key: ${quote(variable.key)}`);
      add(`    value: ${quote(variable.value)}`);
    }
  }
  addScripts(collection.event);
  addAuth(collection.auth);
});

let order = 0;
function walk(items, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const item of items ?? []) {
    order += 1000;
    if (item.item) {
      const folder = path.join(directory, safe(item.name));
      writeYaml(path.join(folder, '.resources', 'definition.yaml'), () => {
        add('$kind: collection');
        add(`name: ${quote(item.name)}`);
        add(`order: ${order}`);
        if (item.description) {
          add('description: |-');
          for (const line of String(item.description).split(/\r?\n/)) add(`  ${line}`);
        }
        addScripts(item.event);
        addAuth(item.auth);
      });
      walk(item.item, folder);
      continue;
    }

    const request = item.request ?? {};
    const url = typeof request.url === 'string' ? request.url : request.url?.raw ?? '';
    writeYaml(path.join(directory, `${safe(item.name)}.request.yaml`), () => {
      add('$kind: http-request');
      add(`name: ${quote(item.name)}`);
      add(`method: ${request.method}`);
      add(`url: ${quote(url)}`);
      add(`order: ${order}`);
      if (request.header?.length) {
        add('headers:');
        for (const header of request.header) {
          add(`  - key: ${quote(header.key)}`);
          add(`    value: ${quote(header.value)}`);
          if (header.disabled !== undefined) add(`    disabled: ${Boolean(header.disabled)}`);
        }
      }
      const query = request.url?.query ?? [];
      if (query.length) {
        add('queryParams:');
        for (const param of query) {
          add(`  - key: ${quote(param.key)}`);
          add(`    value: ${quote(param.value)}`);
          if (param.disabled !== undefined) add(`    disabled: ${Boolean(param.disabled)}`);
        }
      }
      const variables = request.url?.variable ?? [];
      if (variables.length) {
        add('pathVariables:');
        for (const variable of variables) {
          add(`  - key: ${quote(variable.key)}`);
          add(`    value: ${quote(variable.value)}`);
        }
      }
      if (request.body?.mode === 'raw') {
        add('body:');
        add(`  type: ${request.body.options?.raw?.language ?? 'text'}`);
        add('  content: |-');
        for (const bodyLine of String(request.body.raw ?? '').split(/\r?\n/)) add(`    ${bodyLine}`);
      }
      addAuth(request.auth);
      addScripts(item.event);
    });
  }
}
walk(collection.item, root);

writeYaml(path.join('postman', 'environments', 'Umodzi Connect - Local.environment.yaml'), () => {
  add(`name: ${quote(environment.name)}`);
  add('values:');
  for (const variable of environment.values ?? []) {
    add(`  - key: ${quote(variable.key)}`);
    add(`    value: ${quote(variable.value)}`);
    add(`    enabled: ${variable.enabled !== false}`);
    add(`    type: ${quote(variable.type ?? 'default')}`);
  }
});

console.log('Converted Postman collection and environment.');
