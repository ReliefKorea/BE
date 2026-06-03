# 한국 재난구호·기부모집 단체 DB용 데이터

생성일: 2026-05-27

## 파일 구성
- `korea_relief_organizations.csv`: DB import 또는 엑셀 확인용 CSV
- `korea_relief_organizations.sql`: SQLite 호환 `CREATE TABLE` + `INSERT`
- `korea_relief_organizations.json`: 프론트엔드/Node.js 테스트용 JSON

## 주의
- 대부분 공식 홈페이지에서 확인한 데이터입니다.
- 대한적십자사는 공식 사이트가 조회 시점에 타임아웃되어 보조 출처 기반으로 넣었고, `data_confidence=MEDIUM`으로 표시했습니다.
- 실제 서비스에 넣기 전에는 기부 페이지 URL, 기부금영수증 정책, 전화번호, 사업자번호를 한 번 더 검증하는 것을 권장합니다.

## 추천 사용법
SQLite:
```bash
sqlite3 relief.db < korea_relief_organizations.sql
```

Node.js에서 CSV/JSON을 불러와 초기 시드 데이터로 사용할 수 있습니다.
