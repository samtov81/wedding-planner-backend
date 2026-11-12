import { Inject, Injectable } from '@nestjs/common'

import { SubidaDeFacturas } from '@/modules/storage/application/subida-de-facturas'
import type { SubidaPreparada } from '@/modules/storage/application/subida-directa'
import { AlmacenamientoNoDisponibleError } from '@/modules/storage/domain/imagen'

import type { ArchivoFactura } from '../domain/expense'
import { ArchivoDeFacturaNoEncontradoError, GastoNoEncontradoError } from '../domain/expense-errors'
import { EXPENSE_REPOSITORY, type ExpenseRepository } from './expense.repository'

/** Prefijo de las keys de R2 de las facturas de un evento (spec 2026-11-11 §7). */
export const prefijoFacturas = (eventId: string): string => `events/${eventId}/invoices`

/**
 * Lo que manda el cliente al guardar un gasto con archivo: la key que le dio
 * `PrepararSubidaFacturaUseCase` y el nombre original, que R2 no guarda.
 */
export interface ArchivoSubido {
  key: string
  name: string
}

/**
 * Comprueba en R2 que la key es de este evento y respeta tipo y tamaño, y
 * devuelve lo que se guarda: tipo y tamaño los dice el bucket, no el cliente.
 * Una key ajena o inexistente es `INVALID_UPLOAD` (422).
 */
export async function confirmarArchivo(
  subidas: SubidaDeFacturas,
  eventId: string,
  archivo: ArchivoSubido,
): Promise<ArchivoFactura> {
  const { contentType, bytes } = await subidas.confirmar(prefijoFacturas(eventId), archivo.key)
  return { key: archivo.key, name: archivo.name, contentType, bytes }
}

/** Firma la subida directa a R2 bajo el prefijo del evento (PDF/JPG/PNG/WebP ≤ 10 MB). */
@Injectable()
export class PrepararSubidaFacturaUseCase {
  constructor(private readonly subidas: SubidaDeFacturas) {}

  ejecutar(eventId: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    return this.subidas.preparar(prefijoFacturas(eventId), contentType, bytes)
  }
}

/**
 * URL prefirmada para descargar el archivo de un gasto con su nombre original
 * (spec 2026-11-11 §8). 404 `EXPENSE_NOT_FOUND` si el gasto no es del evento,
 * 404 `INVOICE_FILE_NOT_FOUND` si no tiene archivo. Sin R2 configurado
 * `firmarLectura` devuelve `null`, y eso es un 503: el archivo existe pero no
 * hay cómo servirlo. Alternativa descartada: devolver `{ url: null }`, que el
 * cliente tendría que distinguir de un enlace roto.
 */
@Injectable()
export class ArchivoDeGastoUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly gastos: ExpenseRepository,
    private readonly subidas: SubidaDeFacturas,
  ) {}

  async ejecutar(eventId: string, expenseId: string): Promise<{ url: string }> {
    const gasto = await this.gastos.buscarPorId(eventId, expenseId)
    if (gasto === null) throw new GastoNoEncontradoError()
    if (gasto.invoiceFile === null) throw new ArchivoDeFacturaNoEncontradoError()
    const url = await this.subidas.firmarLectura(gasto.invoiceFile.key, gasto.invoiceFile.name)
    if (url === null) throw new AlmacenamientoNoDisponibleError()
    return { url }
  }
}
