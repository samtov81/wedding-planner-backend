import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Starting database seed...')
  // Conectar primero: sin base de datos falla aquí, no a mitad de sembrar.
  await prisma.$connect()

  // Add your seed data here
  // Example:
  // const user = await prisma.user.create({
  //   data: {
  //     email: 'test@example.com',
  //     passwordHash: '$argon2...',
  //     fullName: 'Test User',
  //   },
  // });

  console.log('✅ Database seed completed')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
