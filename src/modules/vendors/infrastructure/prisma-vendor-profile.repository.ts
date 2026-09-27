import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'

import type {
  NuevoPaquete,
  VendorProfileRepository,
} from '../application/vendor-profile.repository'
import type {
  Contacto,
  DatosDeFicha,
  EstadoDeFicha,
  FichaDeProveedor,
  FotoDePortfolio,
} from '../domain/vendor-profile'

const CON_HIJOS = {
  user: { select: { avatarKey: true } },
  category: { select: { id: true, slug: true, name: true } },
  packages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
  portfolioImages: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.VendorProfileInclude

type FilaCompleta = Prisma.VendorProfileGetPayload<{ include: typeof CON_HIJOS }>

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null
}

/** `contact` es JSON: se lee a la defensiva (filas anteriores a este esquema). */
function aContacto(json: Prisma.JsonValue): Contacto {
  const objeto =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {}
  return { email: texto(objeto.email), phone: texto(objeto.phone), website: texto(objeto.website) }
}

function aFicha(fila: FilaCompleta): FichaDeProveedor {
  const conCoordenadas =
    fila.locationAddress !== null && fila.locationLat !== null && fila.locationLng !== null
  return {
    id: fila.id,
    userId: fila.userId,
    status: fila.status,
    avatarKey: fila.user.avatarKey,
    businessName: fila.businessName,
    category: { id: fila.category.id, slug: fila.category.slug, name: fila.category.name },
    specialty: fila.specialty,
    tagline: fila.tagline,
    bio: fila.bio,
    quote: fila.quote,
    yearsExperience: fila.yearsExperience,
    responseTime: fila.responseTime,
    currency: fila.currency,
    publications: fila.publications,
    contact: aContacto(fila.contact),
    location: conCoordenadas
      ? {
          name: fila.locationName,
          address: fila.locationAddress ?? '',
          lat: Number(fila.locationLat),
          lng: Number(fila.locationLng),
          mapboxId: fila.locationMapboxId,
        }
      : null,
    packages: fila.packages.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price.toFixed(2),
    })),
    portfolio: fila.portfolioImages.map((f) => ({
      id: f.id,
      storageKey: f.storageKey,
      alt: f.alt,
    })),
  }
}

function aColumnas(datos: DatosDeFicha): Omit<Prisma.VendorProfileUncheckedCreateInput, 'userId'> {
  return {
    businessName: datos.businessName,
    categoryId: datos.category.id,
    specialty: datos.specialty,
    tagline: datos.tagline,
    bio: datos.bio,
    quote: datos.quote,
    yearsExperience: datos.yearsExperience,
    responseTime: datos.responseTime,
    currency: datos.currency,
    publications: datos.publications,
    contact: { ...datos.contact },
    locationName: datos.location?.name ?? null,
    locationAddress: datos.location?.address ?? null,
    locationLat: datos.location?.lat ?? null,
    locationLng: datos.location?.lng ?? null,
    locationMapboxId: datos.location?.mapboxId ?? null,
  }
}

@Injectable()
export class PrismaVendorProfileRepository implements VendorProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscarPorUsuario(userId: string): Promise<FichaDeProveedor | null> {
    const fila = await clienteDe(this.prisma).vendorProfile.findUnique({
      where: { userId },
      include: CON_HIJOS,
    })
    return fila === null ? null : aFicha(fila)
  }

  async buscarPublicada(id: string): Promise<FichaDeProveedor | null> {
    const fila = await this.prisma.vendorProfile.findFirst({
      where: { id, status: 'PUBLISHED' },
      include: CON_HIJOS,
    })
    return fila === null ? null : aFicha(fila)
  }

  async guardarDatos(userId: string, datos: DatosDeFicha): Promise<FichaDeProveedor> {
    const columnas = aColumnas(datos)
    const fila = await clienteDe(this.prisma).vendorProfile.upsert({
      where: { userId },
      create: { ...columnas, userId },
      update: columnas,
      include: CON_HIJOS,
    })
    return aFicha(fila)
  }

  async fijarEstado(fichaId: string, estado: EstadoDeFicha): Promise<void> {
    await clienteDe(this.prisma).vendorProfile.updateMany({
      where: { id: fichaId },
      data: { status: estado },
    })
  }

  async bloquearFicha(fichaId: string): Promise<void> {
    await clienteDe(this.prisma).$queryRaw`
      SELECT id FROM vendor_profiles WHERE id = ${fichaId}::uuid FOR UPDATE
    `
  }

  async reemplazarPaquetes(fichaId: string, paquetes: NuevoPaquete[]): Promise<void> {
    const db = clienteDe(this.prisma)
    await db.vendorPackage.deleteMany({ where: { vendorProfileId: fichaId } })
    await db.vendorPackage.createMany({
      data: paquetes.map((p, position) => ({
        vendorProfileId: fichaId,
        name: p.name,
        description: p.description,
        price: new Prisma.Decimal(p.price),
        position,
      })),
    })
  }

  async agregarFoto(
    fichaId: string,
    foto: { storageKey: string; alt: string },
  ): Promise<FotoDePortfolio> {
    const db = clienteDe(this.prisma)
    const { _max } = await db.vendorPortfolioImage.aggregate({
      where: { vendorProfileId: fichaId },
      _max: { position: true },
    })
    const fila = await db.vendorPortfolioImage.create({
      data: { vendorProfileId: fichaId, ...foto, position: (_max.position ?? -1) + 1 },
    })
    return { id: fila.id, storageKey: fila.storageKey, alt: fila.alt }
  }

  async cambiarAlt(fichaId: string, fotoId: string, alt: string): Promise<boolean> {
    const { count } = await clienteDe(this.prisma).vendorPortfolioImage.updateMany({
      where: { id: fotoId, vendorProfileId: fichaId },
      data: { alt },
    })
    return count > 0
  }

  async borrarFoto(fichaId: string, fotoId: string): Promise<string | null> {
    const db = clienteDe(this.prisma)
    const foto = await db.vendorPortfolioImage.findFirst({
      where: { id: fotoId, vendorProfileId: fichaId },
      select: { storageKey: true },
    })
    if (foto === null) return null
    await db.vendorPortfolioImage.delete({ where: { id: fotoId } })
    return foto.storageKey
  }

  async reordenarFotos(fichaId: string, ids: string[]): Promise<void> {
    const db = clienteDe(this.prisma)
    for (const [position, id] of ids.entries()) {
      await db.vendorPortfolioImage.updateMany({
        where: { id, vendorProfileId: fichaId },
        data: { position },
      })
    }
  }

  async contarBodas(fichaId: string): Promise<number> {
    const eventos = await this.prisma.eventVendor.findMany({
      where: { vendorProfileId: fichaId, status: 'BOOKED' },
      distinct: ['eventId'],
      select: { eventId: true },
    })
    return eventos.length
  }

  async similares(
    ficha: { id: string; category: { id: string } },
    limite: number,
  ): Promise<FichaDeProveedor[]> {
    const filas = await this.prisma.vendorProfile.findMany({
      where: {
        id: { not: ficha.id },
        status: 'PUBLISHED',
        categoryId: ficha.category.id,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limite,
      include: CON_HIJOS,
    })
    return filas.map(aFicha)
  }
}
