/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Get,
  type INestApplication,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import request from 'supertest'

import { NotFoundError } from '../domain/domain-error'
import { DomainExceptionFilter } from './domain-exception.filter'
import { RequestIdMiddleware } from './request-id.middleware'

// Controlador de prueba que lanza un error de dominio
@Controller('test')
class TestController {
  @Get('not-found')
  notFound(): void {
    throw new NotFoundError('Recurso no encontrado')
  }
}

// Módulo de prueba mínimo sin dependencias externas
@Module({
  controllers: [TestController],
})
class TestAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}

interface ErrorResponse {
  code: string
  message: string
  requestId?: string
}

describe('DomainExceptionFilter e2e', () => {
  let app: INestApplication
  let server: unknown

  beforeAll(async () => {
    app = await NestFactory.create(TestAppModule, { logger: false })
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
    server = app.getHttpServer()
  })

  afterAll(async () => {
    await app.close()
  })

  it('traduce un error de dominio a su código HTTP en la aplicación real', async () => {
    const response = (await (request(server) as unknown).get('/test/not-found')) as {
      status: number
      body: ErrorResponse
    }

    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Recurso no encontrado',
    })
  })

  it('nunca incluye el stack en la respuesta en la aplicación real', async () => {
    const response = (await (request(server) as unknown).get('/test/not-found')) as {
      body: ErrorResponse
    }

    expect(JSON.stringify(response.body)).not.toMatch(/at /)
  })

  it('incluye requestId en la respuesta', async () => {
    const response = (await (request(server) as unknown).get('/test/not-found')) as {
      body: ErrorResponse
    }

    expect(response.body.requestId).toBeDefined()
    expect(typeof response.body.requestId).toBe('string')
    if (response.body.requestId !== undefined) {
      expect(response.body.requestId.length).toBeGreaterThan(0)
    }
  })

  it('propaga el requestId del header x-request-id si está presente', async () => {
    const response = (await (request(server) as unknown)
      .get('/test/not-found')
      .set('x-request-id', 'custom-req-123')) as { body: ErrorResponse }

    expect(response.body.requestId).toBe('custom-req-123')
  })

  it('devuelve el x-request-id en la cabecera de respuesta', async () => {
    const response = (await (request(server) as unknown).get('/test/not-found')) as {
      headers: Record<string, unknown>
    }

    expect(response.headers['x-request-id']).toBeDefined()
    expect(typeof response.headers['x-request-id']).toBe('string')
  })
})
