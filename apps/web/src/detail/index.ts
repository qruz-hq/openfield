// The detail view (§4.0): one entry for every list that opens an image.
//
//   const open = useOpenDetail();
//   <button {...detailTarget(item.id)} onClick={() => open(item.id)}>…</button>
//   <DetailView items={loaded} query={query} hasMore={…} loadingMore={…} onLoadMore={…} />
//
// useIsLastViewed(id) tells a card to show the Last viewed badge after the view closes on it.

export { DetailView, type DetailViewProps } from "./detail-view";
export {
  closeDetailView,
  DETAIL_PARAM,
  DETAIL_TARGET,
  detailTarget,
  useDetail,
  useIsLastViewed,
  useLastViewed,
  useOpenDetail,
} from "./use-detail";
