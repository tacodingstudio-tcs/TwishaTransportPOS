import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'

export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
): void {
  req.log.error({ err, url: req.url, method: req.method }, 'Request error')

  // Zod validation errors → 422 with field-level detail
  if (err instanceof ZodError) {
    const flat = err.flatten()
    reply.status(422).send({
      error: 'Validation failed',
      issues: flat.fieldErrors,
      formErrors: flat.formErrors,
      detail: err.errors.map(e => `${e.path.join('.') || 'root'}: ${e.message}`),
    })
    return
  }

  // Prisma unique constraint violation → 409
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      reply.status(409).send({
        error: 'Conflict',
        message: 'A record with these details already exists',
      })
      return
    }
    if (err.code === 'P2025') {
      reply.status(404).send({
        error: 'Not found',
        message: 'Record not found',
      })
      return
    }
    if (err.code === 'P2003') {
      reply.status(422).send({
        error: 'Invalid reference',
        message: 'A referenced record does not exist',
      })
      return
    }
  }

  // JWT errors → 401
  if (err.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
    reply.status(401).send({ error: 'Token expired' })
    return
  }

  // Rate limit → 429
  if (err.statusCode === 429) {
    reply.status(429).send({
      error: 'Too many requests',
      message: 'Slow down — try again in a minute',
    })
    return
  }

  // Known HTTP errors pass through as-is
  if (err.statusCode && err.statusCode < 500) {
    reply.status(err.statusCode).send({ error: err.message })
    return
  }

  // Unknown server errors → 500 (never expose internals to client)
  reply.status(500).send({
    error: 'Internal server error',
    requestId: req.id,
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message, stack: err.stack }),
  })
}
