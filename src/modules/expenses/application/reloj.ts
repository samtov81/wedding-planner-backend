/**
 * Reloj inyectable de los casos de uso de gastos: "hoy" depende de la hora, y
 * un test que no puede fijarla no puede probar la frontera de un día en otra
 * zona horaria. No existe un reloj en `shared`, así que cada caso lo recibe
 * como parámetro `@Optional()` con este token: en producción Nest no lo
 * encuentra, inyecta `undefined` y manda el valor por defecto del parámetro
 * (`() => new Date()`); un test pasa su propia función. Alternativa
 * descartada: registrar el provider en el módulo, que obligaría a cablear algo
 * que sólo sirve para tests.
 */
export type Reloj = () => Date

export const RELOJ_GASTOS = Symbol('RELOJ_GASTOS')
