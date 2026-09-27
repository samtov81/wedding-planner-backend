import js from '@eslint/js'
import security from 'eslint-plugin-security'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Los ficheros de configuración en la raíz (este, dependency-cruiser,
          // vitest) no viven bajo el tsconfig de src/test: se lintean sin el
          // programa de tipos del proyecto en vez de fallar el parseo.
          allowDefaultProject: [
            'eslint.config.mjs',
            '.dependency-cruiser.cjs',
            'vitest.config.ts',
            'prisma.config.ts',
            'vitest.smoke.config.ts',
            'scripts/*.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      // Task 1 usa la destructuración `const { X: _omitida, ...resto } = obj`
      // para omitir una propiedad; el binding queda deliberadamente sin usar.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      'no-restricted-syntax': [
        'error',
        {
          // Prisma parametriza todo salvo esta función. Es la única vía de
          // inyección SQL que el ORM deja abierta, así que se cierra aquí.
          selector: "MemberExpression[property.name='$queryRawUnsafe']",
          message: 'Prohibido $queryRawUnsafe. Usa $queryRaw con template tag, que parametriza.',
        },
        {
          selector: "MemberExpression[property.name='$executeRawUnsafe']",
          message: 'Prohibido $executeRawUnsafe. Usa $executeRaw con template tag.',
        },
        {
          // El entorno se lee sólo en src/config/env.ts (ver Tarea 1).
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message: 'No leas process.env aquí. Inyecta el token ENV de config/config.module.ts.',
        },
      ],
    },
  },
  {
    files: ['src/config/env.ts', 'src/config/config.module.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // eslint-plugin-security no publica tipos: su export llega como `any` y
    // dispara no-unsafe-argument al pasarlo a tseslint.config() más arriba.
    // El plugin funciona bien en runtime; el hueco es sólo de tipado.
    files: ['eslint.config.mjs'],
    rules: { '@typescript-eslint/no-unsafe-argument': 'off' },
  },
  {
    // Ficheros CommonJS sueltos en la raíz: no pasan por el tsconfig del
    // proyecto y usan los globals de Node (`module`, `require`) sin importarlos.
    files: ['.dependency-cruiser.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    // Scripts de build en Node puro: sus rutas salen de recorrer `dist/`, que
    // acaba de escribir `tsc`, no de ninguna entrada externa, así que la regla
    // de rutas no literales sólo daría falsos positivos.
    files: ['scripts/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
)
