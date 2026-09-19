/**
 * video.dmm.co.jp の JS チャンクから抽出した GraphQL ドキュメント（実物そのまま）。
 * 手で書き換えないこと。フィールドを足すとスキーマ不一致で全体が落ちる。
 * 再抽出は tools/probe-video2.js / scratchpad の extract_op.py を参照。
 */

/** 作品詳細（説明文・ジャンル・タグ・出演者・監督・メーカー・レーベル・シリーズ・発売日・収録時間） */
export const CONTENT_PAGE_DATA_QUERY = `query ContentPageData($id: ID!, $isLoggedIn: Boolean!, $isAmateur: Boolean!, $isAnime: Boolean!, $isAv: Boolean!, $isCinema: Boolean!, $shouldFetchRelatedTags: Boolean = false, $shouldGetBookmark: Boolean!, $guestToken: String!) {
  ppvContent(id: $id) {
    ...ContentData
  }
  reviewSummary(contentId: $id) {
    ...ReviewSummary
  }
}

fragment ContentData on PPVContent {
  id
  floor
  title
  isExclusiveDelivery
  releaseStatus
  description
  notices
  isNoIndex
  isAllowForeign
  isInWishList @include(if: $shouldGetBookmark)
  announcements {
    body
  }
  featureArticles {
    link {
      url
      text
    }
  }
  packageImage {
    largeUrl
    mediumUrl
  }
  sampleImages {
    number
    imageUrl
    largeImageUrl
  }
  products {
    ...ProductData
  }
  mostPopularContentImage {
    ... on ContentSampleImage {
      __typename
      largeImageUrl
      imageUrl
    }
    ... on PackageImage {
      __typename
      largeUrl
      mediumUrl
    }
  }
  pricing {
    lowestEffectivePriceInclusiveTax
    lowestRegularPriceInclusiveTax
    sale {
      name
      id
      endAt
    }
    pointRewardCampaign {
      name
      id
      endAt
      promotionId
      rate
    }
  }
  weeklyRanking: ranking(term: Weekly)
  monthlyRanking: ranking(term: Monthly)
  wishlistCount
  sample2DMovie {
    highestMovieUrl
    hlsMovieUrl
  }
  sampleVRMovie {
    highestMovieUrl
  }
  ...AmateurAdditionalContentData @include(if: $isAmateur)
  ...AnimeAdditionalContentData @include(if: $isAnime)
  ...AvAdditionalContentData @include(if: $isAv)
  ...CinemaAdditionalContentData @include(if: $isCinema)
}

fragment ReviewSummary on ReviewSummary {
  average
  total
  withCommentTotal
  distributions {
    total
    withCommentTotal
    rating
  }
}

fragment ProductData on PPVProduct {
  id
  priority
  isInBasket @include(if: $isLoggedIn)
  isInGuestBasket(token: $guestToken)
  deliveryUnit {
    id
    priority
    streamMaxQualityGroup
    downloadMaxQualityGroup
  }
  pricing {
    regularPriceInclusiveTax
    effectivePriceInclusiveTax
  }
  expireDays
  utilizationStatus @include(if: $isLoggedIn)
  licenseType
  shopName
  couponDiscount {
    coupon {
      name
      expirationPolicy {
        ... on CouponExpirationAt {
          expirationAt
        }
        ... on CouponExpirationDay {
          expirationDays
        }
      }
      expirationAt
      minPayment
      destinationUrl
    }
    discountedPriceInclusiveTax
  }
}

fragment AmateurAdditionalContentData on PPVContent {
  deliveryStartDate
  saleEndDate
  duration
  amateurActress {
    id
    name
    imageUrl
    age
    waist
    bust
    bustCup
    height
    hip
    relatedContents {
      id
      title
    }
  }
  maker {
    id
    name
  }
  label {
    id
    name
  }
  genres {
    id
    name
  }
  makerContentId
  playableInfo {
    ...PlayableInfo
  }
}

fragment AnimeAdditionalContentData on PPVContent {
  deliveryStartDate
  saleEndDate
  duration
  series {
    id
    name
  }
  maker {
    id
    name
  }
  label {
    id
    name
  }
  genres {
    id
    name
  }
  makerContentId
  playableInfo {
    ...PlayableInfo
  }
}

fragment AvAdditionalContentData on PPVContent {
  deliveryStartDate
  saleEndDate
  makerReleasedAt
  duration
  actresses {
    id
    name
    nameRuby
    imageUrl
    bustTop
    bust
    waist
    hip
    height
    ppvSummary(floor: AV) {
      contentCount
    }
    isFavorite @include(if: $shouldGetBookmark)
  }
  histrions {
    id
    name
  }
  directors {
    id
    name
  }
  series {
    id
    name
  }
  maker {
    id
    name
  }
  label {
    id
    name
  }
  genres {
    id
    name
  }
  contentType
  relatedTags(limit: 16) @include(if: $shouldFetchRelatedTags) {
    ... on ContentTagGroup {
      tags {
        id
        name
      }
    }
    ... on ContentTag {
      id
      name
    }
  }
  makerContentId
  playableInfo {
    ...PlayableInfo
  }
}

fragment CinemaAdditionalContentData on PPVContent {
  deliveryStartDate
  saleEndDate
  duration
  actresses {
    id
    name
    nameRuby
    imageUrl
  }
  histrions {
    id
    name
  }
  directors {
    id
    name
  }
  authors {
    id
    name
  }
  series {
    id
    name
  }
  maker {
    id
    name
  }
  label {
    id
    name
  }
  genres {
    id
    name
  }
  makerContentId
  playableInfo {
    ...PlayableInfo
  }
}

fragment PlayableInfo on PlayableInfo {
  playableDevices {
    deviceDeliveryUnits {
      id
      deviceDeliveryQualities {
        isDownloadable
        isStreamable
      }
    }
    device
    name
    priority
    isSupported
  }
  deviceGroups {
    id
    devices {
      deviceDeliveryUnits {
        id
        deviceDeliveryQualities {
          isStreamable
          isDownloadable
        }
      }
      isSupported
    }
  }
  vrViewingType
}`;
