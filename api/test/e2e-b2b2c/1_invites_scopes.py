"""Invites, scopes and who may read what (coach A/B, athletes 1-3)."""
from _common import *

admin, r = reg('adminx'); info('admin', r.status_code)
coachA, _ = reg('coacha'); coachB, _ = reg('coachb'); al1, _ = reg('aluno1'); al2, _ = reg('aluno2'); reg('aluno3')
for s, spec in [(coachA, ['training', 'nutrition', 'assessments']), (coachB, ['training'])]:
    chk('perfil coach salvo', s.post(B + '/api/profile', json={'kind': 'coach', 'coachSpecialties': spec}).status_code == 200)
inv = j(coachA.post(B + '/api/coach/invites', json={'scopes': ['training', 'nutrition', 'assessments']}))
tokA = inv['invite']['token']
chk('invite scope fora da especialidade bloqueado', coachB.post(B + '/api/coach/invites', json={'scopes': ['nutrition']}).status_code == 400)
chk('aluno nao cria convite', al1.post(B + '/api/coach/invites', json={'scopes': ['training']}).status_code == 403)
chk('aluno1 aceita', al1.post(B + '/api/coach/invites/accept', json={'token': tokA}).status_code == 200)
chk('aluno2 nao reusa convite', al2.post(B + '/api/coach/invites/accept', json={'token': tokA}).status_code == 409)
chk('token invalido 410', al2.post(B + '/api/coach/invites/accept', json={'token': 'x' * 20}).status_code == 410)
own = coachA.post(B + '/api/coach/invites', json={'scopes': ['training']}).json()['invite']['token']
chk('coach nao aceita proprio convite', coachA.post(B + '/api/coach/invites/accept', json={'token': own}).status_code == 409)
a1, a2 = uid(al1), uid(al2)
for p in ['routines', 'assessments', 'meal-plans', 'meal-adherence']:
    chk(f'coachB nao le {p} de aluno alheio', coachB.get(B + f'/api/coach/athletes/{a1}/{p}').status_code in (403, 404))
chk('coachA le rotinas do vinculado', coachA.get(B + f'/api/coach/athletes/{a1}/routines').status_code == 200)
chk('aluno2 nao le avaliacoes aluno1', al2.get(B + f'/api/coach/athletes/{a1}/assessments').status_code in (403, 404))
chk('coachA nao prescreve a nao vinculado', coachA.post(B + f'/api/coach/athletes/{a2}/routines', json={'routine': {'name': 'T', 'days': []}}).status_code in (403, 404))
chk('coachB lista vazia', len(j(coachB.get(B + '/api/coach/athletes')).get('links', [])) == 0)
chk('coachA lista 1 vinculo ativo', [l['status'] for l in j(coachA.get(B + '/api/coach/athletes'))['links'] if l['status'] == 'active'] == ['active'])
save('ids', {'a1': a1, 'a2': a2})
summary('1_invites_scopes')
