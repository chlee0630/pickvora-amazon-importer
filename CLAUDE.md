이 Shopify React Router 앱에 아래 기능을 개발해줘.

## 핵심 기능
Amazon PA API 없이 ASIN 직접 입력 방식으로
아마존 상품 정보를 가져와 쇼피파이에 자동 등록하는 앱

## 상품 정보 수집 방식
- Rainforest API (https://www.rainforestapi.com) 사용
- ASIN 단건 입력 또는 여러 ASIN 일괄 입력 지원
- 아마존 Best Sellers / Most Wished For / New Releases
  카테고리에서 인기 상품 ASIN 자동 수집 기능 포함

## 가져올 상품 정보 (모든 정보 수집)
- 상품명 (title)
- 상품 설명 (description, feature_bullets)
- 브랜드 (brand)
- 카테고리 (category)
- 가격 (price, sale_price)
- 재고 상태 (in_stock, stock_quantity)
- 배송비 (shipping_price, prime_eligible)
- 상품 이미지 (main_image, images 전체)
- 옵션/변형 (variants - 색상, 사이즈 등)
- 상품 평점 (rating)
- 리뷰 수 (ratings_total)
- 리뷰 내용 (reviews - 상위 10개)
- ASIN
- 판매 순위 (bestseller_rank)
- 품절 여부 (out_of_stock)
- 상품 상태 (new/used)
- Amazon URL

## 쇼피파이 등록 설정
- 가격 마진율 (%) 설정 기능
  예: 아마존 가격 $10 + 마진 30% = 쇼피파이 판매가 $13
- 배송비 자동 반영 옵션
- 상품 이미지 쇼피파이로 자동 업로드
- 옵션(색상/사이즈 등) 자동 생성
- 리뷰를 상품 설명 하단에 자동 추가
- 태그 자동 생성 (카테고리, 브랜드 등)

## 자동 업데이트 스케줄러
- 가격, 재고, 품절 여부 자동 업데이트
- 업데이트 주기 설정 가능:
  * 1시간마다
  * 하루 2번 (오전 9시, 오후 6시)
  * 하루 1번 (매일 오전 9시)
- 품절 시 쇼피파이 상품 자동 숨김 처리
- 가격 변동 시 마진율 적용하여 자동 반영
- 업데이트 로그 기록 및 대시보드 표시

## 인기 상품 자동 수집
- Amazon Best Sellers 카테고리별 인기 상품 ASIN 자동 수집
- Most Wished For 상품 수집
- New Releases 신상품 수집
- 판매 순위 기준 상위 상품 필터링
- 카테고리 선택 기능 (Electronics, Home, Fashion 등)

## 대시보드 UI (Shopify Polaris 사용)
- 등록된 상품 목록 및 동기화 상태 표시
- ASIN 단건/일괄 입력 폼
- 마진율 설정 패널
- 업데이트 스케줄 설정
- 마지막 업데이트 시간 표시
- 업데이트 로그 (성공/실패 내역)
- 인기 상품 탐색 및 가져오기 패널
- 상품별 아마존 가격 vs 쇼피파이 판매가 비교

## 기술 스택
- Rainforest API: 아마존 상품 데이터 수집
- node-cron: 자동 업데이트 스케줄러
- Shopify Admin API: 상품 등록/수정
- Prisma + SQLite: 상품 동기화 데이터 저장
- Shopify Polaris: UI 컴포넌트

## 환경변수 (.env)
SHOPIFY_API_KEY=f80daf958a9cd56c8435b264a01249a3
SHOPIFY_API_SECRET=[Shopify Client Secret]
RAINFOREST_API_KEY=[Rainforest API Key]
AMAZON_ASSOCIATE_TAG=pickvora-20

## 개발 순서
1. 현재 프로젝트 구조 파악
2. Rainforest API 연동 및 상품 데이터 수집 모듈 개발
3. 쇼피파이 상품 등록/수정 모듈 개발
4. 자동 업데이트 스케줄러 개발
5. 인기 상품 수집 모듈 개발
6. Polaris UI 대시보드 개발
7. 전체 테스트

먼저 현재 프로젝트 구조를 파악하고
단계별 개발 계획을 세워줘.




## 2026-05-20-2
현재 개발 중인 앱에 아래 저작권 보호 필터링 기능을 추가해줘.

## 1. 브랜드 블랙리스트 필터
아래 브랜드가 포함된 상품은 자동 제외:
- Disney, Marvel, DC Comics, Pixar
- Nike, Adidas, Under Armour
- Apple, Microsoft, Sony, Samsung
- Louis Vuitton, Gucci, Chanel, Prada
- Pokemon, Hello Kitty, Sanrio
- Warner Bros, Universal, HBO
- LEGO (공식 라이선스 없는 경우)
- Hasbro, Mattel (공식 라이선스 없는 경우)

DB에 브랜드 블랙리스트 테이블 생성하여
관리자가 대시보드에서 추가/삭제 가능하도록 구현

## 2. 카테고리 자동 제외
아래 카테고리 상품은 자동으로 가져오기 제외:
- Books (도서)
- Music (음악)
- Movies & TV (영화/TV)
- Software (소프트웨어)
- Digital Content (디지털 콘텐츠)
- Video Games (단, 주변기기는 허용)
- Magazine Subscriptions

## 3. 키워드 필터링
상품명/설명에 아래 키워드 포함 시 자동 제외:
- "Official Licensed"
- "Trademark"
- "Copyright ©"
- "All Rights Reserved"
- 브랜드 블랙리스트 키워드

## 4. 상품 등록 전 경고 시스템
- 유명 브랜드 감지 시 주황색 경고 표시
- "이 상품은 판매 권한을 확인하세요" 메시지
- 사용자가 직접 확인 후 등록 여부 결정
- 위험도 표시: 🔴 높음 / 🟡 보통 / 🟢 낮음

## 5. 아마존 제휴 링크 방식 추가
드롭쉬핑 안전 모드 옵션 추가:
- 상품을 쇼피파이에 등록하되
- 구매 버튼 클릭 시 아마존으로 리다이렉트
- Associate Tag(pickvora-20) 자동 포함
- 제휴 수수료 수익 방식
- 설정에서 직접판매/제휴링크 방식 선택 가능

## 6. 면책 조항 자동 추가
모든 상품 설명 하단에 자동으로 추가:
"본 제품은 Amazon.com에서 판매되는 상품입니다.
 구매 시 Amazon으로 이동합니다.
 당사는 Amazon Associates 프로그램 참여자로서
 적격 구매에 대해 수수료를 받습니다."

## 7. 대시보드 UI 추가
Shopify Polaris로 아래 UI 추가:
- 저작권 필터 설정 패널
- 브랜드 블랙리스트 관리 (추가/삭제)
- 제외 카테고리 설정
- 키워드 필터 관리
- 위험 상품 목록 (경고 표시된 상품)
- 판매 방식 설정 (직접판매/제휴링크)

## 8. 로그 기록
- 필터링으로 제외된 상품 목록 기록
- 제외 사유 기록 (브랜드/카테고리/키워드)
- 경고 후 사용자가 등록한 상품 별도 표시