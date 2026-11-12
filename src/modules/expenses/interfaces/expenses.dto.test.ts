import { BadRequestException } from '@nestjs/common'

import { validarCon } from '@/shared/http/validar-con'

import {
  createExpenseSchema,
  listExpensesQuerySchema,
  updateExpenseSchema,
  uploadUrlSchema,
  vendorPaymentsQuerySchema,
} from './expenses.dto'

const base = { concept: 'Anticipo', category: 'Music', amount: 200 }

describe('createExpenseSchema', () => {
  it('externo con monto normalizado y origen construido', () => {
    expect(createExpenseSchema.parse({ ...base, payeeName: ' Imprenta ' })).toMatchObject({
      amount: '200.00',
      origen: { kind: 'external', payeeName: 'Imprenta' },
    })
  })

  it.each([
    [{ ...base }],
    [{ ...base, payeeName: 'X', eventVendorId: '33333333-3333-4333-8333-333333333333' }],
    [{ ...base, payeeName: 'X', amount: 0 }],
    [{ ...base, payeeName: 'X', amount: '12.345' }],
    [{ ...base, payeeName: 'X', dueDate: '2027-13-01' }],
    [{ ...base, eventVendorId: 'no-uuid' }],
  ])('rechaza %o', (entrada) => {
    expect(createExpenseSchema.safeParse(entrada).success).toBe(false)
  })
})

describe('updateExpenseSchema', () => {
  it('exige al menos un cambio y no acepta paidAt', () => {
    expect(updateExpenseSchema.safeParse({}).success).toBe(false)
    expect(updateExpenseSchema.safeParse({ paidAt: '2027-01-01' }).success).toBe(false)
  })

  it('cambiar a externo construye el origen', () => {
    expect(updateExpenseSchema.parse({ payeeName: 'Otro' })).toEqual({
      origen: { kind: 'external', payeeName: 'Otro' },
    })
  })
})

const mensajeDe = (esquema: Parameters<typeof validarCon>[0], entrada: unknown): string => {
  try {
    validarCon(esquema, entrada)
  } catch (error) {
    if (error instanceof BadRequestException) return JSON.stringify(error.getResponse())
    throw error
  }
  return ''
}

describe('factura en el cuerpo (spec 2026-11-11 §8)', () => {
  const ext = { ...base, payeeName: 'Imprenta' }

  it('acepta número, subtotal y archivo, y recorta el número y el nombre', () => {
    expect(
      createExpenseSchema.parse({
        ...ext,
        invoiceNumber: '  F-1 ',
        subtotal: 160,
        invoiceFile: { key: 'events/e/invoices/a.pdf', name: ' factura.pdf ' },
      }),
    ).toMatchObject({
      invoiceNumber: 'F-1',
      subtotal: '160.00',
      invoiceFile: { key: 'events/e/invoices/a.pdf', name: 'factura.pdf' },
    })
  })

  it('null quita (en el PATCH) y es válido', () => {
    expect(
      updateExpenseSchema.parse({ invoiceNumber: null, subtotal: null, invoiceFile: null }),
    ).toEqual({ invoiceNumber: null, subtotal: null, invoiceFile: null })
  })

  it.each([
    ['invoiceNumber vacío', { invoiceNumber: '   ' }],
    ['invoiceNumber de 61', { invoiceNumber: 'x'.repeat(61) }],
    ['subtotal 0.00', { subtotal: '0.00' }],
    ['invoiceFile sin name', { invoiceFile: { key: 'k' } }],
    ['invoiceFile con name de 201', { invoiceFile: { key: 'k', name: 'x'.repeat(201) } }],
    ['invoiceFile con campo extra', { invoiceFile: { key: 'k', name: 'n', bytes: 3 } }],
  ])('rechaza %s con 400', (_caso, extra) => {
    expect(mensajeDe(createExpenseSchema, { ...ext, ...extra })).not.toBe('')
    expect(mensajeDe(updateExpenseSchema, extra)).not.toBe('')
  })

  it('invoiceNumber de 60 es válido', () => {
    expect(
      createExpenseSchema.parse({ ...ext, invoiceNumber: 'x'.repeat(60) }).invoiceNumber,
    ).toHaveLength(60)
  })
})

describe('listExpensesQuerySchema', () => {
  it('status=OVERDUE y q recortada son válidos', () => {
    expect(listExpensesQuerySchema.parse({ status: 'OVERDUE', q: ' luz ' })).toMatchObject({
      status: 'OVERDUE',
      q: 'luz',
    })
  })

  it('q de 101 caracteres o vacía es 400', () => {
    expect(mensajeDe(listExpensesQuerySchema, { q: 'x'.repeat(101) })).not.toBe('')
    expect(mensajeDe(listExpensesQuerySchema, { q: '  ' })).not.toBe('')
  })
})

describe('uploadUrlSchema y vendorPaymentsQuerySchema', () => {
  it('la subida exige tipo y bytes enteros positivos', () => {
    expect(uploadUrlSchema.safeParse({ contentType: 'application/pdf', bytes: 10 }).success).toBe(
      true,
    )
    expect(uploadUrlSchema.safeParse({ contentType: 'application/pdf', bytes: 0 }).success).toBe(
      false,
    )
  })

  it('eventId opcional y uuid', () => {
    expect(vendorPaymentsQuerySchema.parse({})).toEqual({})
    expect(vendorPaymentsQuerySchema.safeParse({ eventId: 'no-uuid' }).success).toBe(false)
  })
})
