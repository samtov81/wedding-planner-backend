import request from 'supertest'

/**
 * Crea un evento completo y lo publica. Los e2e que prueban invitados,
 * vendors o accesos parten de un evento ACTIVE: un borrador no se enseña a
 * proveedores y no es lo que esos tests quieren ejercitar.
 */
export async function crearEventoPublicado(
  url: string,
  accessToken: string,
  name: string,
): Promise<string> {
  const creado = await request(url)
    .post('/events')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name,
      weddingDate: '2027-06-12T00:00:00.000Z',
      timezone: 'America/Bogota',
      currency: 'USD',
      totalBudget: 10000,
      venue: { name: 'Hacienda', address: 'Km 5 vía La Calera', lat: 4.7, lng: -73.9 },
    })
    .expect(201)
  const id = (creado.body as { id: string }).id
  await request(url)
    .post(`/events/${id}/publish`)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200)
  return id
}
