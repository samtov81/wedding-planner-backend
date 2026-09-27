import { randomUUID } from 'node:crypto'

import type {
  NuevoPaquete,
  VendorProfileRepository,
} from '../application/vendor-profile.repository'
import type {
  DatosDeFicha,
  EstadoDeFicha,
  FichaDeProveedor,
  FotoDePortfolio,
} from '../domain/vendor-profile'

interface Fila extends FichaDeProveedor {
  createdAt: number
}

/** Doble en memoria. `bloquearFicha` no hace nada: aquí no hay concurrencia. */
export class VendorProfileRepositoryEnMemoria implements VendorProfileRepository {
  private readonly fichas: Fila[] = []
  private readonly bodas = new Map<string, Set<string>>()
  private readonly avatares = new Map<string, string>()
  private reloj = 0

  /** Para tests: una ficha ya existente con el estado dado. */
  sembrar(userId: string, datos: DatosDeFicha, status: EstadoDeFicha = 'DRAFT'): FichaDeProveedor {
    const fila: Fila = {
      ...structuredClone(datos),
      id: randomUUID(),
      userId,
      status,
      avatarKey: null,
      packages: [],
      portfolio: [],
      createdAt: this.reloj++,
    }
    this.fichas.push(fila)
    return this.copia(fila)
  }

  /** Para tests: la ficha está BOOKED en ese evento. */
  sembrarBoda(fichaId: string, eventId: string): void {
    const eventos = this.bodas.get(fichaId) ?? new Set<string>()
    eventos.add(eventId)
    this.bodas.set(fichaId, eventos)
  }

  /** Para tests: el avatar del perfil personal del dueño. */
  sembrarAvatar(userId: string, key: string): void {
    this.avatares.set(userId, key)
  }

  buscarPorUsuario(userId: string): Promise<FichaDeProveedor | null> {
    const fila = this.fichas.find((f) => f.userId === userId)
    return Promise.resolve(fila === undefined ? null : this.copia(fila))
  }

  buscarPublicada(id: string): Promise<FichaDeProveedor | null> {
    const fila = this.fichas.find((f) => f.id === id && f.status === 'PUBLISHED')
    return Promise.resolve(fila === undefined ? null : this.copia(fila))
  }

  guardarDatos(userId: string, datos: DatosDeFicha): Promise<FichaDeProveedor> {
    const existente = this.fichas.find((f) => f.userId === userId)
    if (existente === undefined) return Promise.resolve(this.sembrar(userId, datos))
    Object.assign(existente, structuredClone(datos))
    return Promise.resolve(this.copia(existente))
  }

  fijarEstado(fichaId: string, estado: EstadoDeFicha): Promise<void> {
    const fila = this.fichas.find((f) => f.id === fichaId)
    if (fila !== undefined) fila.status = estado
    return Promise.resolve()
  }

  bloquearFicha(): Promise<void> {
    return Promise.resolve()
  }

  reemplazarPaquetes(fichaId: string, paquetes: NuevoPaquete[]): Promise<void> {
    const fila = this.fichas.find((f) => f.id === fichaId)
    if (fila !== undefined) fila.packages = paquetes.map((p) => ({ ...p, id: randomUUID() }))
    return Promise.resolve()
  }

  agregarFoto(
    fichaId: string,
    foto: { storageKey: string; alt: string },
  ): Promise<FotoDePortfolio> {
    const fila = this.fichas.find((f) => f.id === fichaId)
    if (fila === undefined) return Promise.reject(new Error('La ficha no existe'))
    const nueva = { id: randomUUID(), ...foto }
    fila.portfolio.push(nueva)
    return Promise.resolve({ ...nueva })
  }

  cambiarAlt(fichaId: string, fotoId: string, alt: string): Promise<boolean> {
    const foto = this.fichas.find((f) => f.id === fichaId)?.portfolio.find((p) => p.id === fotoId)
    if (foto !== undefined) foto.alt = alt
    return Promise.resolve(foto !== undefined)
  }

  borrarFoto(fichaId: string, fotoId: string): Promise<string | null> {
    const fila = this.fichas.find((f) => f.id === fichaId)
    const foto = fila?.portfolio.find((p) => p.id === fotoId)
    if (fila === undefined || foto === undefined) return Promise.resolve(null)
    fila.portfolio = fila.portfolio.filter((p) => p.id !== fotoId)
    return Promise.resolve(foto.storageKey)
  }

  reordenarFotos(fichaId: string, ids: string[]): Promise<void> {
    const fila = this.fichas.find((f) => f.id === fichaId)
    if (fila !== undefined) {
      const porId = new Map(fila.portfolio.map((p) => [p.id, p]))
      fila.portfolio = ids.flatMap((id) => {
        const foto = porId.get(id)
        return foto === undefined ? [] : [foto]
      })
    }
    return Promise.resolve()
  }

  contarBodas(fichaId: string): Promise<number> {
    return Promise.resolve(this.bodas.get(fichaId)?.size ?? 0)
  }

  similares(
    ficha: { id: string; category: { id: string } },
    limite: number,
  ): Promise<FichaDeProveedor[]> {
    const categoria = ficha.category.id
    return Promise.resolve(
      this.fichas
        .filter((f) => f.id !== ficha.id && f.status === 'PUBLISHED' && f.category.id === categoria)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limite)
        .map((f) => this.copia(f)),
    )
  }

  private copia(fila: Fila): FichaDeProveedor {
    const { createdAt: _creada, ...ficha } = structuredClone(fila)
    return { ...ficha, avatarKey: this.avatares.get(fila.userId) ?? null }
  }
}
