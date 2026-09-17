import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Verifica el GATE, no el código: escribe una violación deliberada en un
 * directorio temporal dentro de `src/` y comprueba que dependency-cruiser la
 * caza. Un gate que nunca se ha visto fallar no se sabe si funciona.
 */
function correrCruiser(): { code: number; salida: string } {
  try {
    const salida = execFileSync(
      'npx',
      ['depcruise', 'src', '--config', '.dependency-cruiser.cjs'],
      { encoding: 'utf8' },
    )
    return { code: 0, salida }
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string }
    return { code: e.status, salida: `${e.stdout}${e.stderr}` }
  }
}

describe('regla de dependencia', () => {
  const violacion = join(process.cwd(), 'src/modules/__probe__')

  afterEach(() => rmSync(violacion, { recursive: true, force: true }))

  it('acepta el código actual', () => {
    expect(correrCruiser().code).toBe(0)
  })

  it('rechaza que domain/ importe Prisma', () => {
    mkdirSync(join(violacion, 'domain'), { recursive: true })
    writeFileSync(
      join(violacion, 'domain', 'malo.ts'),
      "import { PrismaClient } from '@prisma/client'\nexport const x = PrismaClient\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/domain-no-depende-de-nada/)
  })

  it('rechaza que application/ importe infrastructure/', () => {
    mkdirSync(join(violacion, 'application'), { recursive: true })
    mkdirSync(join(violacion, 'infrastructure'), { recursive: true })
    writeFileSync(join(violacion, 'infrastructure', 'repo.ts'), 'export const repo = 1\n')
    writeFileSync(
      join(violacion, 'application', 'caso.ts'),
      "import { repo } from '../infrastructure/repo'\nexport const y = repo\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/application-solo-mira-a-domain/)
  })

  // Corrección 1: domain-no-depende-de-nada debe seguir prohibiendo paquetes
  // de node_modules, pero NO los módulos nativos de Node (los necesita la
  // Tarea 12 para `randomBytes`/`createHash`, que son primitivas de la
  // plataforma, no dependencias sustituibles).
  it('acepta que domain/ importe un módulo nativo de Node (node:crypto)', () => {
    mkdirSync(join(violacion, 'domain'), { recursive: true })
    writeFileSync(
      join(violacion, 'domain', 'nativo.ts'),
      "import { randomBytes } from 'node:crypto'\nexport const token = randomBytes(16)\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).toBe(0)
    expect(salida).not.toMatch(/domain-no-depende-de-nada/)
  })
})

// Corrección 2: el brief escribía `to.pathNot` con un lookahead negativo
// (`(?!$1)`) que dependency-cruiser no soporta — `$1` sólo se sustituye
// dentro de `path`/`pathNot`, nunca dentro de un lookahead. Esta suite
// comprueba que, tras la reescritura, la regla SÍ dispara de verdad.
// Corrección 3: el `[^/]+` de `to.pathNot` en domain-no-depende-de-nada no
// estaba atado al módulo capturado en `from`, así que el domain/ de un módulo
// podía importar el domain/ de OTRO módulo y saltarse su puerto público. Se
// reescribe con un grupo de captura en `from.path` y `$1` en `to.pathNot`
// (el mismo patrón que ya usaba `modulos-no-se-tocan-las-tripas`).
describe('regla domain-no-depende-de-nada entre módulos distintos', () => {
  const moduloA = join(process.cwd(), 'src/modules/__probe_dom_a__')
  const moduloB = join(process.cwd(), 'src/modules/__probe_dom_b__')

  afterEach(() => {
    rmSync(moduloA, { recursive: true, force: true })
    rmSync(moduloB, { recursive: true, force: true })
  })

  it('rechaza que el domain/ de un módulo importe el domain/ de otro módulo', () => {
    mkdirSync(join(moduloB, 'domain'), { recursive: true })
    writeFileSync(join(moduloB, 'domain', 'entidad.ts'), 'export const entidad = 1\n')

    mkdirSync(join(moduloA, 'domain'), { recursive: true })
    writeFileSync(
      join(moduloA, 'domain', 'malo.ts'),
      "import { entidad } from '../../__probe_dom_b__/domain/entidad'\nexport const y = entidad\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/domain-no-depende-de-nada/)
  })

  it('acepta que el domain/ de un módulo importe su PROPIO domain/', () => {
    mkdirSync(join(moduloA, 'domain'), { recursive: true })
    writeFileSync(join(moduloA, 'domain', 'entidad.ts'), 'export const entidad = 1\n')
    writeFileSync(
      join(moduloA, 'domain', 'usaEntidad.ts'),
      "import { entidad } from './entidad'\nexport const y = entidad\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).toBe(0)
    expect(salida).not.toMatch(/domain-no-depende-de-nada/)
  })
})

describe('regla modulos-no-se-tocan-las-tripas', () => {
  const moduloA = join(process.cwd(), 'src/modules/__probe_a__')
  const moduloB = join(process.cwd(), 'src/modules/__probe_b__')

  afterEach(() => {
    rmSync(moduloA, { recursive: true, force: true })
    rmSync(moduloB, { recursive: true, force: true })
  })

  it('rechaza que un módulo importe la infrastructure/ de otro módulo', () => {
    mkdirSync(join(moduloB, 'infrastructure'), { recursive: true })
    writeFileSync(join(moduloB, 'infrastructure', 'repo.ts'), 'export const repo = 1\n')

    // Se usa interfaces/ (no application/) para que el único disparo posible
    // sea esta regla, y no también application-solo-mira-a-domain.
    mkdirSync(join(moduloA, 'interfaces'), { recursive: true })
    writeFileSync(
      join(moduloA, 'interfaces', 'controlador.ts'),
      "import { repo } from '../../__probe_b__/infrastructure/repo'\nexport const y = repo\n",
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/modulos-no-se-tocan-las-tripas/)
  })
})
