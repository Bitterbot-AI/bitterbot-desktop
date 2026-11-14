"""Offline, standard-library verification. Never calls a model or executes learned code."""
import hashlib, importlib.util, json, pathlib, statistics, sys
ROOT = pathlib.Path(__file__).resolve().parent
def read(path): return json.loads(path.read_text(encoding="utf8"))
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
def canonical(value): return json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
def replay(name):
    study=ROOT/name
    # The studies own separate checker modules with identical import names.
    for key in ["check_offer","check_common"]: sys.modules.pop(key,None)
    spec=importlib.util.spec_from_file_location(name+"_checker",study/"checker.py")
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    cases={r["id"]:study/"fixtures"/r["id"].rsplit("-",1)[1] for r in read(study/"fixtures/inventory.json")}
    cases.update({"regression-"+p.name:p for p in (ROOT/"original-regression-fixtures").iterdir() if p.is_dir()})
    package=read(study/"candidate-package.json")
    assert hashlib.sha256(canonical(package["manifest"])).hexdigest()==package["packageHash"],"Package manifest hash changed"
    for f in package["manifest"]["files"]:
        p=study/"package"/f["path"]
        assert digest(p)==f["hash"] and p.stat().st_size==f["size"],f["path"]
    artifacts=0
    for filename in ["baseline.json","validate.json"]:
        if not (study/filename).exists():continue
        for r in read(study/filename)["records"]:
            if "invalid" in r["partition"]:continue
            output=study/"direct-runs"/r["arm"]/r["caseId"].rsplit("-",1)[1]/"output/offer_letter_filled.docx"
            actual=module.check(cases[r["caseId"]],output)
            assert actual["status"]==r["grade"]["status"] and digest(output)==r["outputHash"],r["caseId"]
            artifacts+=1
    records=[read(p) for p in sorted((study/"agent-records").glob("*.json"))]
    costs={r["id"]:r["ledgerProviderUsd"] for r in read(study/"usage-and-latency-audit.json")["records"]}
    for r in records:
        output=study/"agent-outputs"/(r["id"]+".docx")
        actual=module.check(cases[r["caseId"]],output)
        assert digest(output)==r["outputHash"],r["id"]
        if r["outcome"] in ["pass","task-failure"]:assert actual["status"]==r["outcome"],r["id"]
        else:
            audit=read(study/"interruption-audit.json")
            assert r["id"]==audit["id"] and actual==audit["supplementaryArtifactGrade"]
        artifacts+=1
    paired={r["caseId"] for r in records if all(any(x["caseId"]==r["caseId"] and x["arm"]==a and x["outcome"] in ["pass","task-failure"] for x in records) for a in ["frozen","learned"])}
    arms=[]
    for arm in ["frozen","learned"]:
        rs=[r for r in records if r["arm"]==arm]
        arms.append(dict(arm=arm,attempts=len(rs),passes=sum(r["outcome"]=="pass" for r in rs),failures=sum(r["outcome"]=="task-failure" for r in rs),interruptions=sum(r["outcome"]=="interrupted" for r in rs),usd=sum(costs[r["id"]] for r in rs),checkedPairMedianMs=statistics.median(r["latencyMs"] for r in rs if r["caseId"] in paired)))
    return dict(study=name,artifacts=artifacts,checkedPairs=len(paired),arms=arms,costReduction=1-arms[1]["usd"]/arms[0]["usd"])
if __name__=="__main__":
    for row in read(ROOT/"source-provenance.json")["files"]:
        assert digest(ROOT/row["path"])==row["sha256"],row["path"]
    print(json.dumps({"sourceHashesVerified":True,"studies":[replay(n) for n in ["source","recipient"]]},indent=2))
