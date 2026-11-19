"""Prescriptions, payload validation, consent, suspend/end/re-link, pending-invite limit. Needs script 1."""
from _common import *

cA = login('coacha'); a1 = login('aluno1'); cB = login('coachb'); a2 = login('aluno2')
a1id, a2id = uid(a1), uid(a2)
lid = j(cA.get(B + '/api/coach/athletes'))['links'][0]['id']
rt = {'routine': {'name': 'Peito', 'notes': 'x', 'divisions': [{'name': 'A', 'exercises': [{'name': 'Supino', 'sets': 3, 'reps': '10', 'load': '20kg', 'restSeconds': 60, 'notes': ''}]}]}}
r = cA.post(B + f'/api/coach/athletes/{a1id}/routines', json=rt)
chk('prescricao com vinculo ativo', r.status_code in (200, 201), r.status_code)
rid = (j(r).get('routine') or j(r).get('prescription') or {}).get('id')
r = a1.get(B + '/api/athlete/prescriptions')
chk('aluno ve prescricao', r.status_code == 200 and rid and rid in json.dumps(j(r)), r.status_code)
bad = json.loads(json.dumps(rt)); bad['routine']['extra'] = 'x'
chk('campo extra rejeitado', cA.post(B + f'/api/coach/athletes/{a1id}/routines', json=bad).status_code == 400)
bad = json.loads(json.dumps(rt)); bad['routine']['name'] = '<img src=x onerror=alert(1)>'
r = cA.post(B + f'/api/coach/athletes/{a1id}/routines', json=bad); info('xss name ->', r.status_code, str(j(r))[:120])
chk('aluno2 nao mexe no vinculo alheio', a2.post(B + '/api/coach/links/status', json={'linkId': lid, 'status': 'ended'}).status_code == 404)
chk('coachB nao mexe no vinculo alheio', cB.post(B + '/api/coach/links/status', json={'linkId': lid, 'status': 'ended'}).status_code == 404)
r = a1.post(B + f'/api/athlete/coaches/{lid}/assessment-consent', json={'granted': False})
chk('aluno revoga consentimento', r.status_code == 200 and 'assessments' not in j(r)['link']['scopes'], r.status_code)
chk('coach perde acesso a avaliacoes apos revogar', cA.get(B + f'/api/coach/athletes/{a1id}/assessments').status_code == 403)
chk('coach mantem treino', cA.get(B + f'/api/coach/athletes/{a1id}/routines').status_code == 200)
chk('aluno suspende', a1.post(B + '/api/coach/links/status', json={'linkId': lid, 'status': 'suspended'}).status_code == 200)
chk('suspenso bloqueia coach', cA.get(B + f'/api/coach/athletes/{a1id}/routines').status_code == 403)
chk('suspenso bloqueia escrita', cA.post(B + f'/api/coach/athletes/{a1id}/routines', json=rt).status_code == 403)
info('aluno ainda ve prescricoes suspenso:', a1.get(B + '/api/athlete/prescriptions').status_code)
chk('status active via API recusado', cA.post(B + '/api/coach/links/status', json={'linkId': lid, 'status': 'active'}).status_code == 400)
chk('encerrar', cA.post(B + '/api/coach/links/status', json={'linkId': lid, 'status': 'ended'}).status_code == 200)
chk('encerrado bloqueia', cA.get(B + f'/api/coach/athletes/{a1id}/routines').status_code in (403, 404))
tok = j(cA.post(B + '/api/coach/invites', json={'scopes': ['training']}))['invite']['token']
chk('re-vinculo apos encerrar', a1.post(B + '/api/coach/invites/accept', json={'token': tok}).status_code == 200)
chk('coach volta a ler rotinas apos re-vinculo', cA.get(B + f'/api/coach/athletes/{a1id}/routines').status_code == 200)
codes = []
for i in range(40):
    r = cA.post(B + '/api/coach/invites', json={'scopes': ['training']}); codes.append(r.status_code)
    if r.status_code != 201:
        break
chk('limite de convites pendentes responde 4xx antes de 40', codes[-1] != 201 and len(codes) < 40, f'{len(codes)} tentativas, ultimo {codes[-1]}')
summary('2_prescriptions_consent')
