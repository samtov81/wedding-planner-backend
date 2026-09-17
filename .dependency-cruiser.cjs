/**
 * La regla de dependencia de la Clean Architecture, como gate de CI.
 * Los nombres de las reglas los citan los tests de `test/architecture/`:
 * si renombras una, actualiza el test.
 */

// Módulos nativos de Node que domain/ puede usar como primitivas de la
// plataforma (p. ej. `randomBytes`/`createHash` en la Tarea 12). No son
// dependencias sustituibles como un paquete de node_modules, así que quedan
// fuera de la prohibición de domain-no-depende-de-nada. Cubre tanto el
// prefijo `node:` como el nombre "pelado" histórico.
const NODE_BUILTINS =
  '^(node:|(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|trace_events|tty|url|util|v8|vm|worker_threads|zlib)$)'

module.exports = {
  forbidden: [
    {
      name: 'domain-no-depende-de-nada',
      severity: 'error',
      comment:
        'domain/ es el núcleo: entidades y reglas puras. No conoce Prisma, ni NestJS, ni Zod, ' +
        'ni ningún paquete externo. Los módulos nativos de Node (node:crypto, etc.) son ' +
        'primitivas de la plataforma, no dependencias sustituibles, y quedan permitidos. Si ' +
        'necesita algo de node_modules, es un puerto en application/.',
      from: { path: '^src/modules/[^/]+/domain' },
      to: {
        pathNot: `^src/(modules/[^/]+/domain|shared/domain)|${NODE_BUILTINS}`,
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'application-solo-mira-a-domain',
      severity: 'error',
      comment: 'Los casos de uso no conocen adaptadores: dependen de puertos, que ellos definen.',
      from: { path: '^src/modules/[^/]+/application' },
      to: { path: '^src/modules/[^/]+/(infrastructure|interfaces)' },
    },
    {
      name: 'modulos-no-se-tocan-las-tripas',
      severity: 'error',
      comment:
        'Un módulo consume el puerto público de otro, nunca su infrastructure/. ' +
        'Cruzar esa línea convierte dos módulos en uno.',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/[^/]+/infrastructure', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'sin-ciclos',
      severity: 'error',
      comment: 'Un ciclo de importación es una frontera de módulo mal puesta.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sin-huerfanos',
      severity: 'warn',
      from: { orphan: true, pathNot: '\\.(test|spec)\\.ts$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.test\\.ts$' },
  },
}
