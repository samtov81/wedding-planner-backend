import { updateMemberSchema } from './members.dto'

describe('updateMemberSchema', () => {
  it('acepta rol, nivel o ambos', () => {
    expect(updateMemberSchema.parse({ role: 'COUPLE' })).toEqual({ role: 'COUPLE' })
    expect(updateMemberSchema.parse({ budgetAccess: 'view' })).toEqual({ budgetAccess: 'view' })
    expect(updateMemberSchema.parse({ role: 'PLANNER', budgetAccess: 'none' })).toEqual({
      role: 'PLANNER',
      budgetAccess: 'none',
    })
  })

  it.each([{}, { budgetAccess: 'edit' }, { role: 'VENDOR' }, { status: 'ACTIVE' }])(
    'rechaza %o',
    (cuerpo) => {
      expect(updateMemberSchema.safeParse(cuerpo).success).toBe(false)
    },
  )
})
