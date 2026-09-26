import { subscribeEvents } from "../api/events";
import { applyLibraryEvent } from "../api/hooks/library";

// Library caches follow the event stream for the life of the app, not only while /assets is open:
// counts, folders and the Trash stay right when an image is made or deleted elsewhere (§2.8).
// Imported once, for this side effect, by the router.
subscribeEvents(applyLibraryEvent);
