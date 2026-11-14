import copy
import json
import random
import unittest
import varied_fixture as v


def wrong_inputs(family,x,variant):
    """Semantic bug probes, distinct from generic empty/constant-output probes."""
    x=copy.deepcopy(x)
    if family=='temporal':
        if variant==0: x['asof']=100000
        if variant==1:
            for r in x['records']: r['deleted']=False
        if variant==2:
            for r in x['records']: r['recorded']=-r['recorded']
        if variant==3:
            for r in x['records']: r['end']+=1
        if variant==4:
            for r in x['records']: r['start']-=1
        if variant==5:
            for r in x['records']: r['value']=abs(r['value'])
        if variant==6: x['windows']=list(reversed(x['windows']))
        if variant==7: x['records']=[r for r in x['records'] if not r['deleted']]
    elif family=='ledger':
        if variant==0:
            for i,b in enumerate(x['batches']): b['id']=str(i)
        if variant==1: x['batches']=list(reversed(x['batches']))
        if variant==2:
            x['batches']=[dict(id=str(i),actions=[a]) for i,a in enumerate(a for b in x['batches'] for a in b['actions'])]
        if variant==3:
            for b in x['batches']: b['actions']=[a for a in b['actions'] if a['op']!='ship']
        if variant==4:
            for b in x['batches']: b['actions']=[a for a in b['actions'] if a['op']!='release']
        if variant==5:
            for b in x['batches']:
                for a in b['actions']:
                    if a['op']=='hold': a['qty']=1
        if variant==6: x['stock']={k:n+1 for k,n in x['stock'].items()}
        if variant==7:
            for b in x['batches']: b['actions']=[a for a in b['actions'] if a['op']!='restock']
    elif family=='resolver':
        for records in x['packages'].values():
            for r in records:
                if variant==0: r['conflicts']={}
                if variant==1: r['deps']={}
                if variant==2: r['deps']={k:[max(1,a-1),b+1] for k,(a,b) in r['deps'].items()}
                if variant==3: r['deps']={k:[a+1,b] for k,(a,b) in r['deps'].items()}
        if variant==4: x['mode']='fresh' if x['mode']=='minimal-change' else 'minimal-change'
        if variant==5: x['roots']=list(x['packages'])
        if variant==6: x['roots']=[]
        if variant==7: x['packages']={n:sorted(rs,key=lambda r:r['v'])[:1] for n,rs in x['packages'].items()}
    elif family=='schedule':
        if variant==0: x['blackouts']=[]
        if variant==1: x['mode']='weighted' if x['mode']=='late-count' else 'late-count'
        if variant==2: x['blackouts']=[[a,b+1] for a,b in x['blackouts']]
        for j in x['jobs']:
            if variant==3: j['after']=[]
            if variant==4: j['release']=0
            if variant==5: j['weight']=1
            if variant==6: j['due']=0
            if variant==7: j['duration']+=1
    elif family=='parser':
        text=''.join(x['chunks'])
        if variant==0: x['sep']=';' if x['sep']==',' else ','
        if variant==1: text='\n'.join(x['chunks'])
        if variant==2: text=text.strip()
        if variant==3: text=text.replace('\r\n','\n')
        if variant==4: text=text.replace('#','h')
        if variant==5: text=text.replace('""','"')
        if variant==6: text=text.replace('\r','')
        if variant==7: text=text.replace('"','')
        x['chunks']=[text]
    elif family=='allocation':
        for p in x['recipients']: p['weight']=int(p['weight'])
        if variant==0: x['tie']='ascending' if x['tie']=='descending' else 'descending'
        if variant==1: x['total']+=1
        for p in x['recipients']:
            if variant==2: p['weight']=1
            if variant==3: p['max']=p['min']+10000
            if variant==4: p['min']=0
            if variant==5: p['weight']=max(1,int(float(p['weight'])))
            if variant==6: p['max']=p['min']
            if variant==7: p['weight']=10**18+1-p['weight']
    return x


def semantic_qualification(corpus):
    audit=[]
    for family in v.CONTRACTS:
        tasks=[t for t in corpus['tasks'] if t['family']==family]
        cases=[t for task in tasks for t in task['tests'][2:]]
        counts=[sum(v.SOLVERS[family](wrong_inputs(family,t['input'],i))!=t['expected'] for t in cases) for i in range(8)]
        audit.append(dict(family=family,mutants=8,rejected=sum(n>0 for n in counts),counterexamplesPerMutant=counts))
    return audit


class FixtureTests(unittest.TestCase):
    def test_independent_answers_and_semantic_mutants(self):
        corpus=v.fixture()
        self.assertEqual(12,len(corpus['tasks']))
        for audit in semantic_qualification(corpus):
            self.assertEqual(8,audit['rejected'],audit)

    def test_boundary_contracts(self):
        for text,expected in [('',{'rows':[],'error':None}), ('\n',{'rows':[['']],'error':None}), ('a,',{'rows':[['a','']],'error':None}), ('"a""',{'rows':[],'error':4}), ('ok\n"x"z',{'rows':[['ok']],'error':6}), ('"a\r\nb"',{'rows':[['a\r\nb']],'error':None}), ('#x\r',{'rows':[],'error':2})]:
            for fn in (v.parser,v.parser_alt): self.assertEqual(expected,fn({'chunks':list(text),'sep':','}))
        # EXACT arithmetic witness: double precision erases the strict weight difference.
        x={'total':1,'tie':'ascending','recipients':[{'id':'a','weight':str(10**18-1),'min':0,'max':1},{'id':'b','weight':str(10**18),'min':0,'max':1}]}
        self.assertEqual({'a':0,'b':1},v.allocation(x))
        self.assertEqual(v.allocation(x),v.allocation_alt(x))

    def test_more_seeds_and_metamorphic_invariance(self):
        for family in v.CONTRACTS:
            for mode in range(2):
                for x in v.generate(family,9182,mode,60):
                    expected=v.SOLVERS[family](copy.deepcopy(x))
                    self.assertEqual(expected,v.ALTERNATES[family](copy.deepcopy(x)),(family,x))
                    twin=copy.deepcopy(x)
                    if family=='parser': twin['chunks']=list(''.join(x['chunks']))
                    elif family=='allocation': twin['recipients'].reverse()
                    elif family=='temporal': twin['records'].reverse()
                    elif family=='resolver':
                        for rs in twin['packages'].values(): rs.reverse()
                    elif family=='schedule': twin['jobs'].reverse(); twin['blackouts'].reverse()
                    else: continue
                    self.assertEqual(expected,v.SOLVERS[family](twin),(family,'invariance'))


if __name__=='__main__': unittest.main()
