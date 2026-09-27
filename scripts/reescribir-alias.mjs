// Reescribe los alias `@/…` del JavaScript compilado a rutas relativas.
//
// Por qué existe (ruling C20): `tsc` resuelve `paths` para COMPROBAR tipos, pero
// emite el especificador tal cual. `dist/` quedaba lleno de `require("@/…")` y
// `node dist/main.js` moría con `Cannot find module`. Vitest resuelve el alias
// por su cuenta, así que ningún test lo veía.
//
// Por qué un script y no `tsc-alias` o `tsconfig-paths`:
//  - `tsc-alias` hace exactamente esto, pero añade siete dependencias con rangos
//    `^` (chokidar, globby…) que se EJECUTAN en cada build. Con `faker` 6.6.6
//    comprometido en este mismo árbol, cada dependencia de build es superficie.
//  - `tsconfig-paths` en runtime obliga a arrancar con `-r tsconfig-paths/register`
//    y un tsconfig apuntando a `dist/`: `node dist/main.js` a secas seguiría
//    roto, y es lo primero que alguien escribe.
// La transformación es mecánica (un único alias, un único formato de salida de
// tsc: `require("@/x")`), y el script falla si deja algo sin reescribir o si
// una ruta reescrita no existe. El test de humo del build compilado
// (`test/smoke/`) arranca el resultado con `node` y es la prueba de que basta.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const DIST = resolve(import.meta.dirname, '..', 'dist')
const ALIAS = /\brequire\((["'])@\/([^"']+)\1\)/g

/**
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* ficherosJs(dir) {
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) yield* ficherosJs(ruta)
    else if (ruta.endsWith('.js')) yield ruta
  }
}

/** @param {string} destino */
function existeModulo(destino) {
  return existsSync(`${destino}.js`) || existsSync(join(destino, 'index.js'))
}

if (!existsSync(DIST)) {
  console.error(`reescribir-alias: no existe ${DIST}; ¿ha corrido tsc?`)
  process.exit(1)
}

let ficheros = 0
let reescritos = 0
/** @type {string[]} */
const rotos = []

for (const fichero of ficherosJs(DIST)) {
  const original = readFileSync(fichero, 'utf8')
  /** @type {(todo: string, comilla: string, especificador: string) => string} */
  const reescribir = (_todo, comilla, especificador) => {
    const destino = join(DIST, especificador)
    if (!existeModulo(destino)) rotos.push(`${relative(DIST, fichero)} → @/${especificador}`)
    let relativa = relative(dirname(fichero), destino).split(sep).join('/')
    if (!relativa.startsWith('.')) relativa = `./${relativa}`
    reescritos += 1
    return `require(${comilla}${relativa}${comilla})`
  }
  const nuevo = original.replace(ALIAS, reescribir)
  if (nuevo !== original) {
    writeFileSync(fichero, nuevo)
    ficheros += 1
  }
}

// Cualquier otra forma de referirse al alias (un `import()` dinámico, otra
// sintaxis de módulo) no se ha reescrito: mejor romper el build que el arranque.
const restantes = [...ficherosJs(DIST)].filter((f) => /["']@\//.test(readFileSync(f, 'utf8')))

if (rotos.length > 0 || restantes.length > 0) {
  for (const r of rotos) console.error(`reescribir-alias: el destino no existe: ${r}`)
  for (const f of restantes)
    console.error(`reescribir-alias: queda un alias sin reescribir en ${f}`)
  process.exit(1)
}

console.log(`reescribir-alias: ${reescritos} imports en ${ficheros} ficheros`)
