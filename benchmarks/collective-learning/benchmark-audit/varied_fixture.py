"""Authored executable-task DEVELOPMENT corpus. No efficacy or independence claim.

Each family has two independent answer algorithms, fixed public contracts, public
examples and private generated inputs. Different seeds are instances, not families.
No model APIs. Reference code and private answers stay on the host.
"""
import copy
import hashlib
import itertools
import json
import random
import re
import sys
from fractions import Fraction
from pathlib import Path


CONTRACTS = {
    "temporal": """Implement solve(x) for bitemporal coverage. x has records, asof, windows. Each record has id (string), revision (integer), recorded (integer), start, end, value (integers), deleted (boolean). First keep records with recorded<=asof. For each id retain exactly ONE record, the maximum by (recorded,revision), and discard every other record for that id. These pairs are unique within an id. A chosen tombstone deletes that entire id, including earlier intervals. For each integer time t in each half-open window [start,end), among surviving nondeleted records covering t choose largest (start,revision,id), comparing id lexicographically. Return a list in window order of objects {total,covered,segments}. total is the sum of winning value over integer times, covered is the count with any winner (including zero-valued winners). segments is a list [start,end,id,value] of maximal contiguous runs of the SAME winning id and value; omit uncovered gaps. Windows and records may overlap, be unsorted, have negative times, zero lengths, and negative values. Time bounds are integers between -30 and 80, start<=end. Empty records/windows are valid. Sorting records in place must not affect other inputs.""",
    "ledger": """Implement solve(x) for an atomic inventory event ledger. x has stock (map of SKU strings to nonnegative integers) and batches in arrival order. A batch has id and actions. A previously SUCCESSFUL batch id is a duplicate: ignore all its actions and output 'duplicate', even if its new content differs. Failed batch ids remain retryable. Actions run sequentially on a speculative copy; any invalid action rejects the entire batch, including all changes to stock and reservations. Output 'rejected' or 'accepted' per new batch. Actions: {op:'restock',sku,qty} increases on-hand by qty; {op:'hold',key,sku,qty} creates a unique active reservation iff unreserved stock suffices; {op:'release',key} deletes an existing reservation without changing on-hand; {op:'ship',key,qty} consumes that positive quantity from an existing reservation AND on-hand, deleting the reservation when exhausted. A shipped or released key can be reused. qty must be a positive integer. Unknown SKUs/keys, repeated active hold keys and unknown operations are invalid. For restock/hold/ship only the fields needed by that operation matter. Empty actions are accepted. Initial SKU inventory cannot be negative; inputs otherwise follow this schema. Return {statuses,stock,available,holds}; holds maps active keys to {sku,qty}; available subtracts all active reservation quantities per SKU. JSON object order is irrelevant. Rejecting a batch must not mark its id successful or consume a hold key.""",
    "resolver": """Implement solve(x) for constrained package selection. x has packages (map of package name to version records), roots (required names), installed (name->version number), and mode, either 'minimal-change' or 'fresh'. A version record has v (positive integer), deps (name->[inclusive minimum,maximum]), conflicts (name->[inclusive minimum,maximum]). Versions of each package are distinct and input order is arbitrary. A solution selects exactly one version for each root and every package transitively required by its selected versions' deps, and NO packages outside that dependency closure. Cyclic dependencies are allowed when all constraints hold. Every dependency range must contain the selected version. A conflict forbids selecting the named package in that range; conflicts are directional and any selected record's conflict applies. Unselected packages do not conflict. Missing root/dependency names make the corresponding choice impossible. In minimal-change mode minimize (number of names whose selected value differs from installed, sum of selected version numbers, sorted list of [name,version]); absent in one map and present in the other counts as a change. In fresh mode minimize (-sum of selected version numbers, number selected, sorted list of [name,version]). Return the selected map, or null if impossible. There are at most 6 packages and 3 versions per package. Do not retain unrelated installed packages. Empty roots require an empty map, even in fresh mode.""",
    "schedule": """Implement solve(x) for exact nonpreemptive single-machine scheduling. x has jobs, blackouts, mode. Each job has id (unique string), release>=0, duration>0, due>=0, weight>=0, after (list of prerequisite job ids). A valid order contains every job exactly once and respects prerequisites; missing prerequisites or cycles make it impossible. Starting at time zero, for each job in that order start at the earliest time >=previous finish and release whose half-open execution interval does not overlap ANY half-open blackout. Blackouts may overlap, be unsorted or have zero length. No inserted discretionary idle time is allowed. In 'weighted' mode choose smallest (sum weight*max(0,finish-due), sum finish, lexicographic job-id order). In 'late-count' mode choose smallest (number of jobs with finish>due, sum weight*max(0,finish-due), sum finish, lexicographic order). Return {order,starts,finishes,penalty,late}; lists follow the chosen order and penalty always means weighted tardiness. Return null if impossible. At most 7 jobs; empty jobs gives empty lists and zero totals. All times are integers; blackout endpoints are nonnegative with start<=end. Compare the whole objective, not just the first component.""",
    "parser": """Implement solve(x) as a strict streaming delimited-record parser. x has chunks (list of strings) and sep (';' or ','). Concatenate chunks without adding characters; chunk boundaries have no semantic meaning. Unicode offsets below count Python characters, not UTF-8 bytes. Separator ends a field; LF or CRLF ends a record outside quotes. Bare CR outside quotes is invalid at that CR index. A quoted field begins ONLY when a double quote is the very first character of the field. Inside quotes, doubled double quotes represent one literal quote; separators, LF and CR (including CRLF) are literal characters preserved exactly. The first nondoubled quote closes the field, and ONLY a separator, LF, CRLF or EOF may follow; other characters cause error at that character. Quotes inside an unquoted field cause error at the quote. Spaces are literal, never trimmed. A record whose first character is '#' outside quotes is a comment: skip all characters through LF or CRLF; quotes/separators inside comments are ignored, but a bare CR is still invalid. '#'-prefixed later fields are not comments. Empty physical records produce ['']; an empty entire stream produces []. A trailing record terminator does NOT create an extra record; trailing separator DOES create an empty final field. Unclosed quote at EOF errors at len(text), even when a CR occurred inside it. Return {rows,error}; error is null on success, else the first invalid character index or len(text). On error return only FULLY terminated preceding noncomment records, discarding the incomplete current record. This rule also applies to an invalid character after a closing quote. At EOF a complete noncomment record without a terminator is appended; an EOF comment is ignored.""",
    "allocation": """Implement solve(x) for exact capped proportional integer allocation. x has total (nonnegative integer), recipients (unique id strings, weight a positive integer ENCODED AS A DECIMAL STRING, min>=0, max>=min integers), and tie ('ascending' or 'descending'). Return null if total is outside [sum(min),sum(max)]. Otherwise assign minima first. For remaining amount R, compute continuous extras e_i=min(max_i-min_i,lambda*weight_i), with common nonnegative rational lambda chosen so sum(e_i)=R. If R=0 all extras are zero. Assign floor(e_i) first, then one extra unit to each of the remaining recipients in decreasing fractional-remainder order, breaking equal fractions by id ascending or descending as tie specifies. Never exceed max. Return map id->integer allocation. No binary floating-point rounding is permitted by the mathematical contract: very large integer weights (up to 10^18) and exact ties occur. Weight strings preserve these integers across JSON runtimes; convert them to exact integers for arithmetic. No recipients and total=0 returns {}; otherwise empty recipients is infeasible. Input ordering has no priority. Minima do not contribute to weight or change the proportional extras rule.""",
}


def temporal(x):
    latest = {}
    for r in x['records']:
        if r['recorded'] <= x['asof'] and (r['id'] not in latest or (r['recorded'], r['revision']) > (latest[r['id']]['recorded'], latest[r['id']]['revision'])):
            latest[r['id']] = r
    live = [r for r in latest.values() if not r['deleted']]
    results = []
    for a,b in x['windows']:
        edges = sorted({a,b} | {max(a,min(b,r[k])) for r in live for k in ('start','end')})
        total=covered=0; segments=[]
        for l,h in zip(edges,edges[1:]):
            eligible = [r for r in live if r['start'] <= l < r['end']]
            if not eligible or h<=l: continue
            r = max(eligible,key=lambda r:(r['start'],r['revision'],r['id']))
            total += (h-l)*r['value']; covered += h-l
            if segments and segments[-1][1] == l and segments[-1][2:] == [r['id'],r['value']]: segments[-1][1]=h
            else: segments.append([l,h,r['id'],r['value']])
        results.append(dict(total=total,covered=covered,segments=segments))
    return results


def temporal_alt(x):
    live=[]
    for name in set(r['id'] for r in x['records']):
        history=sorted([r for r in x['records'] if r['id']==name and r['recorded']<=x['asof']],key=lambda r:(r['recorded'],r['revision']))
        if history and not history[-1]['deleted']: live.append(history[-1])
    result=[]
    for a,b in x['windows']:
        vals=[]
        for t in range(a,b):
            candidates=sorted([r for r in live if r['start']<=t<r['end']],key=lambda r:(r['start'],r['revision'],r['id']))
            vals.append((t,candidates[-1] if candidates else None))
        seg=[]
        for t,r in vals:
            if r is None: continue
            if seg and seg[-1][1]==t and seg[-1][2:]==[r['id'],r['value']]: seg[-1][1]=t+1
            else: seg.append([t,t+1,r['id'],r['value']])
        result.append({'total':sum(r['value'] for _,r in vals if r),'covered':sum(r is not None for _,r in vals),'segments':seg})
    return result


def ledger(x):
    stock=x['stock'].copy(); holds={}; seen=set(); statuses=[]
    for b in x['batches']:
        if b['id'] in seen: statuses.append('duplicate'); continue
        s=stock.copy(); h=copy.deepcopy(holds); valid=True
        for a in b['actions']:
            op=a.get('op'); q=a.get('qty'); sku=a.get('sku'); k=a.get('key')
            if op in ('restock','hold','ship') and (type(q)!=int or q<=0): valid=False; break
            if op=='restock' and sku in s: s[sku]+=q
            elif op=='hold' and sku in s and k not in h and s[sku]-sum(v['qty'] for v in h.values() if v['sku']==sku)>=q: h[k]={'sku':sku,'qty':q}
            elif op=='release' and k in h: del h[k]
            elif op=='ship' and k in h and h[k]['qty']>=q:
                s[h[k]['sku']]-=q; h[k]['qty']-=q
                if h[k]['qty']==0: del h[k]
            else: valid=False; break
        statuses.append('accepted' if valid else 'rejected')
        if valid: stock,holds=s,h; seen.add(b['id'])
    return dict(statuses=statuses,stock=stock,available={k:v-sum(h['qty'] for h in holds.values() if h['sku']==k) for k,v in stock.items()},holds=holds)


def ledger_alt(x):
    # Independent representation: available units plus reservation tuples, instead of on-hand.
    avail=x['stock'].copy(); reserved={}; accepted=[]; status=[]
    for batch in x['batches']:
        if batch['id'] in accepted: status.append('duplicate'); continue
        free=avail.copy(); held=reserved.copy(); ok=True
        for a in batch['actions']:
            op=a.get('op'); key=a.get('key'); q=a.get('qty'); sku=a.get('sku')
            if op=='release':
                if key not in held: ok=False; break
                product,n=held.pop(key); free[product]+=n
            elif op not in ('restock','hold','ship') or type(q)!=int or q<1: ok=False; break
            elif op=='restock':
                if sku not in free: ok=False; break
                free[sku]+=q
            elif op=='hold':
                if sku not in free or key in held or free[sku]<q: ok=False; break
                free[sku]-=q; held[key]=(sku,q)
            else:
                if key not in held or held[key][1]<q: ok=False; break
                product,n=held.pop(key)
                if n>q: held[key]=(product,n-q)
        if ok: avail,reserved=free,held; accepted.append(batch['id'])
        status.append('accepted' if ok else 'rejected')
    return {'statuses':status,'available':avail,'stock':{p:n+sum(q for s,q in reserved.values() if s==p) for p,n in avail.items()},'holds':{k:dict(sku=s,qty=q) for k,(s,q) in reserved.items()}}


def resolver_score(x,chosen):
    pairs=sorted(chosen.items()); total=sum(chosen.values())
    if x['mode']=='fresh': return (-total,len(chosen),pairs)
    return (sum(chosen.get(k)!=x['installed'].get(k) for k in set(chosen)|set(x['installed'])),total,pairs)


def resolver(x):
    names=sorted(x['packages']); best=None; answer=None
    for choices in itertools.product(*[[None]+p for p in (x['packages'][n] for n in names)]):
        selected={n:r for n,r in zip(names,choices) if r is not None}
        required=set(x['roots']); todo=list(required); valid=True
        while todo:
            n=todo.pop()
            if n not in selected: valid=False; break
            for dep in selected[n]['deps']:
                if dep not in required: required.add(dep); todo.append(dep)
        if not valid or required!=set(selected): continue
        for r in selected.values():
            for n,(a,b) in r['deps'].items():
                if n not in selected or not a<=selected[n]['v']<=b: valid=False
            for n,(a,b) in r['conflicts'].items():
                if n in selected and a<=selected[n]['v']<=b: valid=False
        if valid:
            chosen={n:r['v'] for n,r in selected.items()}; score=resolver_score(x,chosen)
            if best is None or score<best: best,answer=score,chosen
    return answer


def resolver_alt(x):
    best=None; answer=None
    def search(selected,needed):
        nonlocal best,answer
        missing=sorted(needed-set(selected))
        if missing:
            name=missing[0]
            for record in x['packages'].get(name,[]):
                search({**selected,name:record},needed|set(record['deps']))
            return
        for record in selected.values():
            if any(n not in selected or selected[n]['v']<lo or selected[n]['v']>hi for n,(lo,hi) in record['deps'].items()): return
            if any(n in selected and lo<=selected[n]['v']<=hi for n,(lo,hi) in record['conflicts'].items()): return
        chosen={n:r['v'] for n,r in selected.items()}
        # Score calculated independently of the exhaustive oracle's helper.
        if x['mode']=='fresh': score=(-sum(chosen.values()),len(chosen),sorted(chosen.items()))
        else: score=(len([n for n in set(chosen)|set(x['installed']) if chosen.get(n)!=x['installed'].get(n)]),sum(chosen.values()),sorted(chosen.items()))
        if best is None or score<best: best,answer=score,chosen
    search({},set(x['roots'])); return answer


def schedule(x):
    best=None; answer=None
    for jobs in itertools.permutations(x['jobs']):
        done=set(); t=0; starts=[]; ends=[]; penalty=late=0
        for j in jobs:
            if not set(j['after'])<=done: break
            t=max(t,j['release'])
            while True:
                conflict=[b for a,b in x['blackouts'] if a<b and t<b and t+j['duration']>a]
                if not conflict: break
                t=max(conflict)
            starts.append(t); t+=j['duration']; ends.append(t); done.add(j['id'])
            penalty+=j['weight']*max(0,t-j['due']); late+=int(t>j['due'])
        else:
            order=[j['id'] for j in jobs]
            score=(penalty,sum(ends),order) if x['mode']=='weighted' else (late,penalty,sum(ends),order)
            if best is None or score<best: best=score; answer=dict(order=order,starts=starts,finishes=ends,penalty=penalty,late=late)
    return answer


def schedule_alt(x):
    # Enumerate feasible prefixes; simulate occupancy a unit at a time.
    blocked={t for a,b in x['blackouts'] for t in range(a,b)}; best=None; ans=None
    def visit(order,starts,ends,penalty,late):
        nonlocal best,ans
        if len(order)==len(x['jobs']):
            score=([late] if x['mode']=='late-count' else [])+[penalty,sum(ends),order]
            if best is None or score<best: best=score; ans=dict(order=order,starts=starts,finishes=ends,penalty=penalty,late=late)
            return
        for j in x['jobs']:
            if j['id'] in order or any(d not in order for d in j['after']): continue
            t=max(ends[-1] if ends else 0,j['release'])
            while any(k in blocked for k in range(t,t+j['duration'])): t+=1
            end=t+j['duration']
            visit(order+[j['id']],starts+[t],ends+[end],penalty+j['weight']*max(0,end-j['due']),late+int(end>j['due']))
    visit([],[],[],0,0); return ans


def parser(x):
    text=''.join(x['chunks']); sep=x['sep']; rows=[]; row=[]; field=''; state='start'; i=0; active=False
    while i<len(text):
        c=text[i]
        if state=='comment':
            if c not in '\r\n': i+=1; continue
        elif state=='quoted':
            if c=='"':
                if i+1<len(text) and text[i+1]=='"': field+='"'; i+=2; continue
                state='closed'; i+=1; continue
            field+=c; i+=1; continue
        elif state=='start' and not row and not active and c=='#': state='comment'; i+=1; continue
        elif state=='start' and c=='"': state='quoted'; active=True; i+=1; continue
        elif state=='closed' and c not in (sep,'\r','\n'): return dict(rows=rows,error=i)
        elif c=='"': return dict(rows=rows,error=i)
        if c in '\r\n':
            if c=='\r' and (i+1==len(text) or text[i+1]!='\n'): return dict(rows=rows,error=i)
            if state!='comment': rows.append(row+[field])
            row=[]; field=''; active=False; state='start'; i+=2 if c=='\r' else 1
        elif c==sep:
            row.append(field); field=''; state='start'; active=True; i+=1
        else: field+=c; state='plain'; active=True; i+=1
    if state=='quoted': return dict(rows=rows,error=len(text))
    if state!='comment' and active: rows.append(row+[field])
    return dict(rows=rows,error=None)


def parser_alt(x):
    # Field-at-a-time regex grammar, unlike the character-state implementation.
    s=''.join(x['chunks']); d=x['sep']; pos=0; rows=[]
    while pos<len(s):
        if s[pos]=='#':
            end=re.search('[\r\n]',s[pos:])
            if not end: break
            pos+=end.start()
            if s[pos]=='\r' and s[pos:pos+2]!='\r\n': return dict(rows=rows,error=pos)
            pos+=2 if s[pos]=='\r' else 1; continue
        row=[]
        while True:
            if pos<len(s) and s[pos]=='"':
                match=re.match(r'"(?:[^\"]|"")*"(?!")',s[pos:])
                if not match: return dict(rows=rows,error=len(s))
                raw=match[0]; value=raw[1:-1].replace('""','"'); pos+=len(raw)
                if pos<len(s) and s[pos] not in (d,'\r','\n'): return dict(rows=rows,error=pos)
            else:
                match=re.match('[^'+re.escape(d)+'\r\n\"]*',s[pos:]); value=match[0]; pos+=len(value)
                if pos<len(s) and s[pos]=='"': return dict(rows=rows,error=pos)
            row.append(value)
            if pos==len(s): rows.append(row); break
            if s[pos]==d: pos+=1; continue
            if s[pos]=='\r' and s[pos:pos+2]!='\r\n': return dict(rows=rows,error=pos)
            pos+=2 if s[pos]=='\r' else 1; rows.append(row); break
    return dict(rows=rows,error=None)


def allocation(x):
    x=copy.deepcopy(x)
    for p in x['recipients']: p['weight']=int(p['weight'])
    people=x['recipients']; r=x['total']-sum(p['min'] for p in people)
    if r<0 or r>sum(p['max']-p['min'] for p in people): return None
    extras={p['id']:Fraction(0) for p in people}; pending=list(people)
    while pending:
        weight=sum(p['weight'] for p in pending)
        capped=[p for p in pending if Fraction(r*p['weight'],weight)>=p['max']-p['min']]
        if not capped:
            for p in pending: extras[p['id']]=Fraction(r*p['weight'],weight)
            break
        for p in capped: extras[p['id']]=Fraction(p['max']-p['min']); r-=p['max']-p['min']; pending.remove(p)
    out={p['id']:p['min']+int(extras[p['id']]) for p in people}
    priority=sorted(people,key=lambda p:p['id'],reverse=x['tie']=='descending')
    priority.sort(key=lambda p:extras[p['id']]-int(extras[p['id']]),reverse=True)
    for p in priority[:x['total']-sum(out.values())]: out[p['id']]+=1
    return out


def allocation_alt(x):
    x=copy.deepcopy(x)
    for p in x['recipients']: p['weight']=int(p['weight'])
    ps=x['recipients']; r=x['total']-sum(p['min'] for p in ps)
    if not 0<=r<=sum(p['max']-p['min'] for p in ps): return None
    if not ps: return {}
    breaks=sorted({Fraction(0)}|{Fraction(p['max']-p['min'],p['weight']) for p in ps})
    lam=breaks[-1]
    for low,high in zip(breaks,breaks[1:]):
        atlow=sum(min(Fraction(p['max']-p['min']),low*p['weight']) for p in ps)
        slope=sum(p['weight'] for p in ps if Fraction(p['max']-p['min'],p['weight'])>low)
        trial=low+(r-atlow)/slope
        if low<=trial<=high: lam=trial; break
    if r==0: lam=Fraction(0)
    continuous={p['id']:min(Fraction(p['max']-p['min']),lam*p['weight']) for p in ps}
    out={p['id']:p['min']+v.numerator//v.denominator for p in ps for v in [continuous[p['id']]]}
    ranked=sorted(out,reverse=x['tie']=='descending')
    ranked=sorted(ranked,key=lambda n:-(continuous[n]-int(continuous[n])))
    for n in ranked[:x['total']-sum(out.values())]: out[n]+=1
    return out


SOLVERS={n:globals()[n] for n in CONTRACTS}
ALTERNATES={n:globals()[n+'_alt'] for n in CONTRACTS}


def generate(family,seed,mode,count=40):
    rng=random.Random(seed); cases=[]
    for index in range(count):
        if family=='temporal':
            records=[]
            for name in ['a','b','c','d','z'][:rng.randrange(6)]:
                for rev in range(rng.randrange(1,5)):
                    a=rng.randrange(-5,15); records.append(dict(id=name,revision=rev,recorded=rng.randrange(12),start=a,end=a+rng.randrange(12),value=rng.randrange(-4,10),deleted=rng.random()<.22))
            rng.shuffle(records); x=dict(records=records,asof=rng.randrange(12),windows=[[a,a+rng.randrange(25)] for a in [rng.randrange(-10,15) for _ in range(4)]])
        elif family=='ledger':
            batches=[]
            for j in range(18):
                actions=[]
                for _ in range(rng.randrange(4)):
                    actions.append(dict(op=rng.choice(['hold','hold','ship','release','restock','unknown']),sku=rng.choice(['a','b','missing']),key=rng.choice(['k','l','m','n']),qty=rng.choice([-1,0,1,2,3,5])))
                batches.append(dict(id=str(rng.randrange(10)),actions=actions))
            # A successful hold/partial ship followed by rollback, retry and duplicate.
            pre=[dict(id='p',actions=[dict(op='hold',sku='a',key='r',qty=3)]),dict(id='q',actions=[dict(op='ship',key='r',qty=1),dict(op='hold',sku='a',key='r',qty=1)]),dict(id='q',actions=[dict(op='ship',key='r',qty=1)]),dict(id='p',actions=[dict(op='release',key='r')])]
            x=dict(stock={'a':rng.randrange(5,12),'b':rng.randrange(5)},batches=pre+batches)
        elif family=='resolver':
            names=['a','b','c','d','e'][:rng.randrange(2,6)]; packages={}
            for n in names:
                versions=[]
                for v in range(1,rng.randrange(2,5)):
                    deps={}; conflicts={}
                    for m in names+['missing']:
                        if rng.random()<.16: deps[m]=sorted([rng.randrange(1,4),rng.randrange(1,4)])
                        if rng.random()<.055: conflicts[m]=sorted([rng.randrange(1,4),rng.randrange(1,4)])
                    versions.append(dict(v=v,deps=deps,conflicts=conflicts))
                rng.shuffle(versions); packages[n]=versions
            x=dict(packages=packages,roots=rng.sample(names,rng.randrange(len(names)+1)),installed={n:rng.randrange(1,4) for n in names if rng.random()<.6},mode=['minimal-change','fresh'][mode])
        elif family=='schedule':
            jobs=[]
            for j in range(rng.randrange(0,7)):
                jobs.append(dict(id=chr(97+j),release=rng.randrange(9),duration=rng.randrange(1,5),due=rng.randrange(18),weight=rng.randrange(5),after=[chr(97+k) for k in range(j) if rng.random()<.22]))
            if jobs and index%9==0: jobs[0]['after']=[jobs[-1]['id']]
            if jobs and index%11==0: jobs[-1]['after']=['missing']
            rng.shuffle(jobs); x=dict(jobs=jobs,blackouts=[[a,a+rng.randrange(5)] for a in [rng.randrange(15) for _ in range(4)]],mode=['weighted','late-count'][mode])
        elif family=='parser':
            d=[',',';'][mode]; samples=['','\n','\r\n','#ignore\"'+d+'bad\n','a'+d+'b\r\n','"a\r\nb"'+d+'"x""y"\n',d,'""','"unterminated','"a" x','bare"quote','x\ry','##\r','"α🙂"'+d+'#data\n',' '+d+'\n','a'+d+'""'+d,'#last','"a"""','"a""']
            text=''.join(rng.choice(samples) for _ in range(rng.randrange(1,5)))
            points=sorted([0,len(text)]+[rng.randrange(len(text)+1) for _ in range(rng.randrange(12))]); x=dict(chunks=[text[a:b] for a,b in zip(points,points[1:])],sep=d)
        else:
            recipients=[]
            for j in range(rng.randrange(8)):
                low=rng.randrange(6); recipients.append(dict(id=chr(97+j),min=low,max=low+rng.randrange(15),weight=str(rng.choice([1,2,3,10**18,10**18-1,999999999999999937]))))
            rng.shuffle(recipients); lo=sum(p['min'] for p in recipients); hi=sum(p['max'] for p in recipients)
            x=dict(recipients=recipients,total=max(0,rng.randrange(max(0,lo-2),hi+3)),tie=['ascending','descending'][mode])
        cases.append(x)
    return cases


def fixture(partition='headroom',replica=0):
    tasks=[]; audit=[]
    for family in CONTRACTS:
        for mode in range(2):
            seed=int(hashlib.sha256(f'{partition}:{replica}:{family}:{mode}:v1'.encode()).hexdigest()[:16],16)
            cases=generate(family,seed,mode)
            expected=[SOLVERS[family](copy.deepcopy(x)) for x in cases]
            independent=[ALTERNATES[family](copy.deepcopy(x)) for x in cases]
            if expected!=independent: raise AssertionError(f'Independent oracle disagreement {family}/{mode}: '+str(next(i for i,(a,b) in enumerate(zip(expected,independent)) if a!=b)))
            # Nonempty plausible, null, dropped records, wrong types, stale-example,
            # wrong numeric content, and order-sensitive corruption controls.
            mutations=[None,{},[],True,0,'',expected[0],{'error':None,'rows':[]}]
            rejected=[any(type(m)!=type(e) or m!=e for e in expected[2:]) for m in mutations]
            assert all(rejected), (family,mode,rejected)
            tasks.append(dict(id=f'{partition}-r{replica}-{family}-{mode}',family=family,mode=mode,partition=partition,replica=replica,input=dict(contract=CONTRACTS[family],examples=[dict(input=cases[i],output=expected[i]) for i in range(2)],implementation='Python 3 standard library; define solve(x).'),tests=[dict(input=x,expected=e) for x,e in zip(cases,expected)]))
            audit.append(dict(family=family,mode=mode,independentAgreements=len(cases),incorrectConstantProbes=len(mutations),incorrectAccepted=0))
    return dict(schemaVersion=1,purpose='Authored development; not a powered efficacy corpus',families=6,partition=partition,replica=replica,tasks=tasks,qualification=audit)


if __name__=='__main__':
    dest=Path(sys.argv[1]); dest.mkdir(parents=True,exist_ok=False)
    corpus=fixture(sys.argv[2] if len(sys.argv)>2 else 'headroom')
    (dest/'fixture.json').write_text(json.dumps(corpus,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'tasks':len(corpus['tasks']),'independentComparisons':sum(a['independentAgreements'] for a in corpus['qualification'])}))
