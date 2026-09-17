import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'

import { DomainError, InvalidCursorError } from '../domain'

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
        { err: exception, url: req.url, requestId: req.requestId },
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
