import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'

import { DomainError, InvalidCursorError } from '../domain'
import { urlParaRegistro } from '../logging/redaccion'

interface RespuestaDeError {
  code: string
  message: string
  requestId?: string
  details?: unknown
}

/**
 * Única salida de errores del backend. Regla: lo que no es un DomainError
 * conocido sale como 500 genérico. Un `connect ECONNREFUSED 10.0.0.5:5432`
 * devuelto al cliente le regala la topología interna a quien esté sondeando.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const req = ctx.getRequest<{ url?: string; requestId?: string }>()
    const res = ctx.getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>()

    const { status, cuerpo } = this.traducir(exception)
    if (req.requestId !== undefined) cuerpo.requestId = req.requestId

    if (status >= 500) {
      this.logger.error(
        { err: exception, url: urlParaRegistro(req.url), requestId: req.requestId },
        'Error no controlado',
      )
    }

    res.status(status).json(cuerpo)
  }

  private traducir(exception: unknown): { status: number; cuerpo: RespuestaDeError } {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        cuerpo: { code: exception.code, message: exception.message },
      }
    }

    if (exception instanceof InvalidCursorError) {
      return { status: 400, cuerpo: { code: 'INVALID_CURSOR', message: exception.message } }
    }

    const delParser = errorDelParser(exception)
    if (delParser !== null) return delParser

    if (exception instanceof HttpException) {
      const respuesta = exception.getResponse()
      return {
        status: exception.getStatus(),
        cuerpo: {
          code: 'HTTP_ERROR',
          message: exception.message,
          ...(typeof respuesta === 'object' ? { details: respuesta } : {}),
        },
      }
    }

    return {
      status: 500,
      cuerpo: { code: 'INTERNAL_ERROR', message: 'Ha ocurrido un error interno' },
    }
  }
}

/**
 * Tipos que body-parser pone en sus errores (`err.type`). Sólo ESTOS se
 * traducen a 4xx: un error cualquiera con un `status` numérico (el de un
 * cliente HTTP interno, por ejemplo) sigue siendo un 500 opaco.
 *
 * Por qué hace falta: el parser corre como middleware de Express y Nest manda
 * su `next(err)` a los filtros. Sin esto, un cuerpo de 2 MB era un 500
 * "Error no controlado" en el log, cuando es un error del cliente.
 */
const TIPOS_DEL_PARSER = new Set([
  'entity.too.large',
  'entity.parse.failed',
  'entity.verify.failed',
  'encoding.unsupported',
  'charset.unsupported',
  'request.aborted',
  'request.size.invalid',
  'parameters.too.many',
])

function errorDelParser(exception: unknown): { status: number; cuerpo: RespuestaDeError } | null {
  if (!(exception instanceof Error)) return null
  const { type, status } = exception as Error & { type?: unknown; status?: unknown }
  if (typeof type !== 'string' || !TIPOS_DEL_PARSER.has(type)) return null
  if (typeof status !== 'number' || status < 400 || status >= 500) return null

  if (status === 413) {
    return {
      status,
      cuerpo: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'El cuerpo de la petición es demasiado grande',
      },
    }
  }
  if (status === 415) {
    return {
      status,
      cuerpo: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Codificación del cuerpo no soportada' },
    }
  }
  // El mensaje del parser (`Unexpected token } in JSON at position 7`) no sale:
  // describe el parser, no la API.
  return {
    status,
    cuerpo: { code: 'INVALID_BODY', message: 'El cuerpo de la petición no es válido' },
  }
}
