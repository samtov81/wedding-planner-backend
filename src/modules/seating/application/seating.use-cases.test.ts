import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'

import type { InvitadoSentable, MesaVista } from '../domain/seating'
import {
  AsientoFueraDeRangoError,
  AsientoOcupadoError,
  LimiteDeMesasError,
  MesaNoEncontradaError,
  OcupanteInvalidoError,
  RangoDeAsientosInvalidoError,
} from '../domain/seating-errors'
import { SeatingRepositoryEnMemoria } from '../infrastructure/seating.repository.fake'
import { AssignSeatUseCase } from './assign-seat.use-case'
import { ClearSeatUseCase } from './clear-seat.use-case'
import { CreateTableUseCase } from './create-table.use-case'
import { DeleteTableUseCase } from './delete-table.use-case'
import { GenerateTablesUseCase } from './generate-tables.use-case'
import { GetSeatingUseCase } from './get-seating.use-case'
import { UpdateTableUseCase } from './update-table.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO = '22222222-2222-4222-8222-222222222222'
const ANA = 'aaaaaaaa-0000-4000-8000-000000000001'
const LUIS = 'aaaaaaaa-0000-4000-8000-000000000002'
const RECHAZO = 'aaaaaaaa-0000-4000-8000-000000000003'

const invitado = (id: string, cambios: Partial<InvitadoSentable> = {}): InvitadoSentable => ({
  id,
  rsvp: 'CONFIRMED',
  companionsAllowed: 0,
  companionsConfirmed: null,
  ...cambios,
})

function montar() {
  const repo = new SeatingRepositoryEnMemoria()
  const udt = new UnidadDeTrabajoEnMemoria()
  repo.sembrarInvitado(EVENTO, invitado(ANA, { companionsAllowed: 2, companionsConfirmed: 1 }))
  repo.sembrarInvitado(EVENTO, invitado(LUIS, { rsvp: 'PENDING', companionsAllowed: 1 }))
  repo.sembrarInvitado(EVENTO, invitado(RECHAZO, { rsvp: 'DECLINED' }))
  return {
    repo,
    udt,
    generar: new GenerateTablesUseCase(repo, udt),
    crear: new CreateTableUseCase(repo, udt),
    actualizar: new UpdateTableUseCase(repo, udt),
    eliminar: new DeleteTableUseCase(repo),
    asignar: new AssignSeatUseCase(repo, udt),
    vaciar: new ClearSeatUseCase(repo, udt),
    leer: new GetSeatingUseCase(repo),
  }
}

const ocupantes = (mesas: MesaVista[]) =>
  mesas.flatMap((m) =>
    m.seats
      .filter((s) => s.occupant !== null)
      .map((s) => [m.name, s.index, s.occupant?.guestId, s.occupant?.companionIndex]),
  )

describe('casos de uso de la distribución', () => {
  it('genera N mesas con el mínimo de asientos, y luego agrega a continuación', async () => {
    const { generar } = montar()
    await generar.ejecutar(EVENTO, { count: 2, minSeats: 4, maxSeats: 8 })

    const mesas = await generar.ejecutar(EVENTO, { count: 1, minSeats: 6, maxSeats: 10 })

    expect(mesas.map((m) => [m.name, m.seatCount, m.seats.length])).toEqual([
      ['Mesa 1', 4, 4],
      ['Mesa 2', 4, 4],
      ['Mesa 3', 6, 6],
    ])
  })

  it('no deja pasar de 100 mesas por evento', async () => {
    const { generar, crear } = montar()
    await generar.ejecutar(EVENTO, { count: 100, minSeats: 1, maxSeats: 1 })

    await expect(
      generar.ejecutar(EVENTO, { count: 1, minSeats: 1, maxSeats: 1 }),
    ).rejects.toBeInstanceOf(LimiteDeMesasError)
    await expect(crear.ejecutar(EVENTO, { minSeats: 1, maxSeats: 1 })).rejects.toBeInstanceOf(
      LimiteDeMesasError,
    )
  })

  it('crea una mesa con nombre propio o "Mesa N"', async () => {
    const { crear } = montar()
    const a = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    const b = await crear.ejecutar(EVENTO, { name: 'Novios', minSeats: 2, maxSeats: 4 })
    expect([a.name, b.name]).toEqual(['Mesa 1', 'Novios'])
    expect(a.seats).toHaveLength(2)
  })

  it('agrega asientos hasta el máximo y no más', async () => {
    const { crear, actualizar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 3 })

    expect((await actualizar.ejecutar(EVENTO, mesa.id, { seatCount: 3 })).seats).toHaveLength(3)
    await expect(actualizar.ejecutar(EVENTO, mesa.id, { seatCount: 4 })).rejects.toBeInstanceOf(
      RangoDeAsientosInvalidoError,
    )
  })

  it('valida el rango contra lo guardado: subir el mínimo por encima de los asientos → 422', async () => {
    const { crear, actualizar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 6 })
    await expect(actualizar.ejecutar(EVENTO, mesa.id, { minSeats: 3 })).rejects.toBeInstanceOf(
      RangoDeAsientosInvalidoError,
    )
  })

  it('quita el último asiento solo si está vacío', async () => {
    const { crear, actualizar, asignar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 1, maxSeats: 4 })
    await actualizar.ejecutar(EVENTO, mesa.id, { seatCount: 3 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 2,
      guestId: ANA,
      companionIndex: 0,
    })

    await expect(actualizar.ejecutar(EVENTO, mesa.id, { seatCount: 2 })).rejects.toBeInstanceOf(
      AsientoOcupadoError,
    )
  })

  it('sienta al titular y a su acompañante', async () => {
    const { crear, asignar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 3, maxSeats: 4 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 0,
    })

    const mesas = await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 1,
      guestId: ANA,
      companionIndex: 1,
    })

    expect(ocupantes(mesas)).toEqual([
      ['Mesa 1', 0, ANA, 0],
      ['Mesa 1', 1, ANA, 1],
    ])
  })

  it('una persona ya sentada se mueve al asiento nuevo', async () => {
    const { crear, asignar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 3, maxSeats: 4 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 0,
    })

    const mesas = await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 2,
      guestId: ANA,
      companionIndex: 0,
    })

    expect(ocupantes(mesas)).toEqual([['Mesa 1', 2, ANA, 0]])
  })

  it('si los dos están sentados, se intercambian, también entre mesas', async () => {
    const { generar, asignar } = montar()
    const [m1, m2] = await generar.ejecutar(EVENTO, { count: 2, minSeats: 2, maxSeats: 4 })
    if (m1 === undefined || m2 === undefined) throw new Error('faltan mesas')
    await asignar.ejecutar(EVENTO, {
      tableId: m1.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 0,
    })
    await asignar.ejecutar(EVENTO, {
      tableId: m2.id,
      seatIndex: 1,
      guestId: LUIS,
      companionIndex: 0,
    })

    const mesas = await asignar.ejecutar(EVENTO, {
      tableId: m2.id,
      seatIndex: 1,
      guestId: ANA,
      companionIndex: 0,
    })

    expect(ocupantes(mesas)).toEqual([
      ['Mesa 1', 0, LUIS, 0],
      ['Mesa 2', 1, ANA, 0],
    ])
  })

  it('si la persona no estaba sentada, el ocupante anterior queda sin asignar', async () => {
    const { crear, asignar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 0,
    })

    const mesas = await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: LUIS,
      companionIndex: 1,
    })

    expect(ocupantes(mesas)).toEqual([['Mesa 1', 0, LUIS, 1]])
  })

  it('reasignar al mismo asiento no cambia nada', async () => {
    const { crear, asignar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    const destino = { tableId: mesa.id, seatIndex: 1, guestId: ANA, companionIndex: 0 }
    await asignar.ejecutar(EVENTO, destino)
    expect(ocupantes(await asignar.ejecutar(EVENTO, destino))).toEqual([['Mesa 1', 1, ANA, 0]])
  })

  it('rechaza a un DECLINED, un acompañante fuera de cupo o un invitado de otro evento', async () => {
    const { crear, asignar, repo } = montar()
    repo.sembrarInvitado(OTRO, invitado('bbbbbbbb-0000-4000-8000-000000000000'))
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    const en = (guestId: string, companionIndex: number) =>
      asignar.ejecutar(EVENTO, { tableId: mesa.id, seatIndex: 0, guestId, companionIndex })

    await expect(en(RECHAZO, 0)).rejects.toBeInstanceOf(OcupanteInvalidoError)
    await expect(en(ANA, 2)).rejects.toBeInstanceOf(OcupanteInvalidoError)
    await expect(en('bbbbbbbb-0000-4000-8000-000000000000', 0)).rejects.toBeInstanceOf(
      OcupanteInvalidoError,
    )
    expect(repo.asignaciones).toHaveLength(0)
  })

  it('rechaza un asiento que la mesa no tiene y una mesa de otro evento', async () => {
    const { crear, asignar } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    const ajena = await crear.ejecutar(OTRO, { minSeats: 2, maxSeats: 4 })

    await expect(
      asignar.ejecutar(EVENTO, { tableId: mesa.id, seatIndex: 2, guestId: ANA, companionIndex: 0 }),
    ).rejects.toBeInstanceOf(AsientoFueraDeRangoError)
    await expect(
      asignar.ejecutar(EVENTO, {
        tableId: ajena.id,
        seatIndex: 0,
        guestId: ANA,
        companionIndex: 0,
      }),
    ).rejects.toBeInstanceOf(MesaNoEncontradaError)
  })

  it('si el invitado rechaza después, su asiento queda marcado como sobrante', async () => {
    const { crear, asignar, repo, leer } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 1,
    })
    const ana = repo.invitados.find((i) => i.id === ANA)
    if (ana === undefined) throw new Error('falta Ana')
    ana.companionsConfirmed = 0

    const [vista] = await leer.ejecutar(EVENTO)

    expect(vista?.seats[0]?.occupant).toEqual({ guestId: ANA, companionIndex: 1, sobrante: true })
  })

  it('vaciar un asiento lo libera; eliminar la mesa libera a todos', async () => {
    const { crear, asignar, vaciar, eliminar, repo } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 0,
    })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 1,
      guestId: LUIS,
      companionIndex: 0,
    })

    await vaciar.ejecutar(EVENTO, mesa.id, 0)
    expect(repo.asignaciones.map((a) => a.guestId)).toEqual([LUIS])

    await eliminar.ejecutar(EVENTO, mesa.id)
    expect(repo.asignaciones).toHaveLength(0)
    await expect(eliminar.ejecutar(EVENTO, mesa.id)).rejects.toBeInstanceOf(MesaNoEncontradaError)
  })

  it('las escrituras corren en una unidad de trabajo', async () => {
    const { crear, asignar, udt } = montar()
    const mesa = await crear.ejecutar(EVENTO, { minSeats: 2, maxSeats: 4 })
    await asignar.ejecutar(EVENTO, {
      tableId: mesa.id,
      seatIndex: 0,
      guestId: ANA,
      companionIndex: 0,
    })
    expect(udt.transacciones).toBe(2)
  })
})
