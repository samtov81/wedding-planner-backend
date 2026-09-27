import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

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

/**
 * Directorio bajo el que viven TODOS los ficheros que esta suite escribe. Tiene
 * que estar dentro de `src/` porque el gate cruza `src/`: un temporal del
 * sistema no lo vería. Cada prueba cuelga de aquí un módulo `__probe*__` que
 * borra al terminar.
 */
const RAIZ_TEMPORAL = resolve(process.cwd(), 'src/modules')

/**
 * La única forma de construir una ruta de escritura en esta suite. Valida dos
 * cosas antes de devolverla: que el resultado sigue DENTRO de `RAIZ_TEMPORAL`
 * (un `..` en las partes no puede sacar la escritura del temporal) y que el
 * módulo es uno de los `__probe*`, para que un error de tecleo no pueda
 * sobrescribir código real del repo. Los `eslint-disable` de las tres
 * envolturas de abajo se apoyan en esta validación: el aviso de
 * `detect-non-literal-fs-filename` vale para una ruta de origen desconocido,
 * no para una que acaba de comprobarse.
 */
function rutaTemporal(...partes: string[]): string {
  const [modulo] = partes
  if (modulo === undefined || !modulo.startsWith('__probe')) {
    throw new Error(`Ruta temporal fuera de un módulo __probe*: ${partes.join('/')}`)
  }
  const resuelta = resolve(RAIZ_TEMPORAL, ...partes)
  if (!resuelta.startsWith(`${RAIZ_TEMPORAL}${sep}`)) {
    throw new Error(`Ruta temporal fuera de ${RAIZ_TEMPORAL}: ${resuelta}`)
  }
  return resuelta
}

function crearDirectorio(...partes: string[]): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta validada dentro del temporal
  mkdirSync(rutaTemporal(...partes), { recursive: true })
}

function escribirFichero(contenido: string, ...partes: string[]): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta validada dentro del temporal
  writeFileSync(rutaTemporal(...partes), contenido)
}

function borrarModulo(modulo: string): void {
  rmSync(rutaTemporal(modulo), { recursive: true, force: true })
}

describe('regla de dependencia', () => {
  const PROBE = '__probe__'

  afterEach(() => borrarModulo(PROBE))

  it('acepta el código actual', () => {
    expect(correrCruiser().code).toBe(0)
  })

  it('rechaza que domain/ importe Prisma', () => {
    crearDirectorio(PROBE, 'domain')
    escribirFichero(
      "import { PrismaClient } from '@prisma/client'\nexport const x = PrismaClient\n",
      PROBE,
      'domain',
      'malo.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/domain-no-depende-de-nada/)
  })

  it('rechaza que application/ importe infrastructure/', () => {
    crearDirectorio(PROBE, 'application')
    crearDirectorio(PROBE, 'infrastructure')
    escribirFichero('export const repo = 1\n', PROBE, 'infrastructure', 'repo.ts')
    escribirFichero(
      "import { repo } from '../infrastructure/repo'\nexport const y = repo\n",
      PROBE,
      'application',
      'caso.ts',
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
    crearDirectorio(PROBE, 'domain')
    escribirFichero(
      "import { randomBytes } from 'node:crypto'\nexport const token = randomBytes(16)\n",
      PROBE,
      'domain',
      'nativo.ts',
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
  const MODULO_A = '__probe_dom_a__'
  const MODULO_B = '__probe_dom_b__'

  afterEach(() => {
    borrarModulo(MODULO_A)
    borrarModulo(MODULO_B)
  })

  it('rechaza que el domain/ de un módulo importe el domain/ de otro módulo', () => {
    crearDirectorio(MODULO_B, 'domain')
    escribirFichero('export const entidad = 1\n', MODULO_B, 'domain', 'entidad.ts')

    crearDirectorio(MODULO_A, 'domain')
    escribirFichero(
      `import { entidad } from '../../${MODULO_B}/domain/entidad'\nexport const y = entidad\n`,
      MODULO_A,
      'domain',
      'malo.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/domain-no-depende-de-nada/)
  })

  it('acepta que el domain/ de un módulo importe su PROPIO domain/', () => {
    crearDirectorio(MODULO_A, 'domain')
    escribirFichero('export const entidad = 1\n', MODULO_A, 'domain', 'entidad.ts')
    escribirFichero(
      "import { entidad } from './entidad'\nexport const y = entidad\n",
      MODULO_A,
      'domain',
      'usaEntidad.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).toBe(0)
    expect(salida).not.toMatch(/domain-no-depende-de-nada/)
  })
})

describe('regla modulos-no-se-tocan-las-tripas', () => {
  const MODULO_A = '__probe_a__'
  const MODULO_B = '__probe_b__'

  afterEach(() => {
    borrarModulo(MODULO_A)
    borrarModulo(MODULO_B)
  })

  it('rechaza que un módulo importe la infrastructure/ de otro módulo', () => {
    crearDirectorio(MODULO_B, 'infrastructure')
    escribirFichero('export const repo = 1\n', MODULO_B, 'infrastructure', 'repo.ts')

    // Se usa interfaces/ (no application/) para que el único disparo posible
    // sea esta regla, y no también application-solo-mira-a-domain.
    crearDirectorio(MODULO_A, 'interfaces')
    escribirFichero(
      `import { repo } from '../../${MODULO_B}/infrastructure/repo'\nexport const y = repo\n`,
      MODULO_A,
      'interfaces',
      'controlador.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/modulos-no-se-tocan-las-tripas/)
  })
})

/**
 * Tarea 11: los `*.test.ts` dejan de estar excluidos del gate. Las reglas de
 * producción los ignoran (un test monta lo que necesita), pero cruzar a la
 * infrastructure/ REAL de otro módulo ata este test a las tripas del otro. Un
 * doble (`*.fake.ts`) sí es contrato público y se permite.
 */
describe('regla tests-solo-dobles-de-otros-modulos', () => {
  const MODULO_A = '__probe_test_a__'
  const MODULO_B = '__probe_test_b__'

  afterEach(() => {
    borrarModulo(MODULO_A)
    borrarModulo(MODULO_B)
  })

  it('rechaza que un test importe la infrastructure/ real de otro módulo', () => {
    // El caso real que había en el repo: el test del worker de invitaciones
    // (`guests`) importaba la plantilla de `mail/infrastructure/templates`.
    crearDirectorio(MODULO_B, 'infrastructure', 'templates')
    escribirFichero(
      'export const plantilla = 1\n',
      MODULO_B,
      'infrastructure',
      'templates',
      'plantilla.ts',
    )

    crearDirectorio(MODULO_A, 'interfaces')
    escribirFichero(
      `import { plantilla } from '../../${MODULO_B}/infrastructure/templates/plantilla'\n` +
        'export const y = plantilla\n',
      MODULO_A,
      'interfaces',
      'worker.test.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).not.toBe(0)
    expect(salida).toMatch(/tests-solo-dobles-de-otros-modulos/)
  })

  it('acepta que un test importe el DOBLE (*.fake.ts) de otro módulo', () => {
    crearDirectorio(MODULO_B, 'infrastructure')
    escribirFichero('export const doble = 1\n', MODULO_B, 'infrastructure', 'cosa.fake.ts')

    crearDirectorio(MODULO_A, 'interfaces')
    escribirFichero(
      `import { doble } from '../../${MODULO_B}/infrastructure/cosa.fake'\n` +
        'export const y = doble\n',
      MODULO_A,
      'interfaces',
      'worker.test.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).toBe(0)
    expect(salida).not.toMatch(/tests-solo-dobles-de-otros-modulos/)
  })

  it('acepta que un test use la infrastructure/ de su PROPIO módulo', () => {
    crearDirectorio(MODULO_A, 'infrastructure')
    crearDirectorio(MODULO_A, 'application')
    escribirFichero('export const repo = 1\n', MODULO_A, 'infrastructure', 'repo.ts')
    escribirFichero(
      "import { repo } from '../infrastructure/repo'\nexport const y = repo\n",
      MODULO_A,
      'application',
      'caso.test.ts',
    )

    const { code, salida } = correrCruiser()

    expect(code).toBe(0)
    expect(salida).not.toMatch(/tests-solo-dobles-de-otros-modulos/)
  })
})
