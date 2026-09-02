from __future__ import annotations
import json
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from app.llm import AnthropicSparkSQLProvider, LLMProvider
from app.metadata import get_metadata_provider
from app.models import AskRequest, FeedbackRequest, SemanticContext, SpaceUpdate
from app.services.chat import ChatService
from app.services.store import Store, now
from app.services.transformations import TransformationService
from app.services.transformation_generation import TransformationGenerationService
from app.settings import get_settings
from app.transformations.models import TransformationRequestData, TransformationSQLGenerateRequest


settings = get_settings()
store = Store(settings.database_path)
llm = LLMProvider(settings.openai_api_key, settings.openai_base_url, settings.openai_model)
chat_service = ChatService(store, settings.fixtures_path, llm)
transformation_service = TransformationService(store)
anthropic_sparksql = AnthropicSparkSQLProvider(settings.anthropic_api_key, settings.anthropic_base_url, settings.anthropic_model, settings.anthropic_timeout_seconds, log_payloads=settings.log_llm_payloads)
generation_service = TransformationGenerationService(anthropic_sparksql)


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.initialize()
    store.seed_demo(settings.metadata_path)
    yield


app = FastAPI(title="DataChat POC", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(Exception)
async def unhandled(_: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": "request_error", "message": str(exc.detail)}})
    return JSONResponse(status_code=400, content={"error": {"code": getattr(exc, "code", "poc_error"), "message": str(exc), "request_id": str(uuid4())[:8]}})


@app.get("/api/health")
def health():
    return {"status": "ok", "mode": settings.app_mode}


@app.get("/api/capabilities")
def capabilities():
    return {"anthropic": {"configured": anthropic_sparksql.configured, "model": settings.anthropic_model or None}}


@app.get("/api/spaces")
def list_spaces():
    return store.rows("SELECT id,name,description,provider_type,target_type,created_at FROM spaces ORDER BY created_at")


@app.get("/api/spaces/{space_id}")
def get_space(space_id: str):
    item = store.one("SELECT id,name,description,provider_type,target_type,instructions FROM spaces WHERE id=?", (space_id,))
    if not item:
        raise HTTPException(404, "Data space not found.")
    item["instructions"] = json.loads(item["instructions"])
    return item


@app.patch("/api/spaces/{space_id}")
def update_space(space_id: str, body: SpaceUpdate):
    changes = body.model_dump(exclude_none=True)
    allowed = {"name", "description", "provider_type", "target_type", "instructions"}
    changes = {key: (json.dumps(value, ensure_ascii=False) if key == "instructions" else value) for key, value in changes.items() if key in allowed}
    if changes:
        store.execute(f"UPDATE spaces SET {','.join(f'{key}=?' for key in changes)} WHERE id=?", (*changes.values(), space_id))
    return get_space(space_id)


@app.get("/api/spaces/{space_id}/metadata")
def get_metadata(space_id: str):
    space = store.one("SELECT * FROM spaces WHERE id=?", (space_id,))
    if not space:
        raise HTTPException(404, "Data space not found.")
    catalog = get_metadata_provider(space["provider_type"]).load_catalog({"path": space["metadata_path"]})
    return catalog.model_dump()


@app.get("/api/spaces/{space_id}/semantics")
def get_semantics(space_id: str):
    item = store.one("SELECT payload FROM semantics WHERE space_id=?", (space_id,))
    return SemanticContext.model_validate_json(item["payload"] if item else "{}").model_dump()


@app.put("/api/spaces/{space_id}/semantics")
def put_semantics(space_id: str, body: SemanticContext):
    store.execute("INSERT INTO semantics(space_id,payload) VALUES (?,?) ON CONFLICT(space_id) DO UPDATE SET payload=excluded.payload", (space_id, body.model_dump_json()))
    return body


@app.post("/api/conversations")
def create_conversation(body: dict):
    return store.create_conversation(body.get("space_id", "sales-demo"), body.get("title", "New conversation"))


@app.get("/api/conversations")
def list_conversations(space_id: str = "sales-demo"):
    return store.rows("SELECT * FROM conversations WHERE space_id=? ORDER BY created_at DESC", (space_id,))


@app.get("/api/conversations/{conversation_id}/messages")
def list_messages(conversation_id: str):
    items = store.rows("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at", (conversation_id,))
    for item in items:
        item.update(json.loads(item.pop("payload")))
    return items


@app.post("/api/conversations/{conversation_id}/messages")
def ask(conversation_id: str, body: AskRequest):
    return chat_service.ask(conversation_id, body.content)


@app.post("/api/messages/{message_id}/feedback")
def feedback(message_id: str, body: FeedbackRequest):
    item = {"id": str(uuid4()), "message_id": message_id, "rating": body.rating, "comment": body.comment, "status": "pending" if body.rating in {"negative", "review"} else "resolved", "created_at": now()}
    store.execute("INSERT INTO feedback VALUES (?,?,?,?,?,?)", tuple(item.values()))
    return item


@app.get("/api/reviews")
def reviews(status: str | None = None):
    sql = "SELECT f.*,m.content,m.payload,c.title FROM feedback f JOIN messages m ON f.message_id=m.id JOIN conversations c ON m.conversation_id=c.id"
    params = ()
    if status:
        sql += " WHERE f.status=?"
        params = (status,)
    items = store.rows(sql + " ORDER BY f.created_at DESC", params)
    for item in items:
        item["response"] = json.loads(item.pop("payload"))
    return items


@app.patch("/api/reviews/{review_id}")
def resolve_review(review_id: str, body: dict):
    status = body.get("status", "resolved")
    store.execute("UPDATE feedback SET status=? WHERE id=?", (status, review_id))
    return {"id": review_id, "status": status}


@app.get("/api/benchmarks")
def benchmarks():
    return {"summary": {"total": 3, "passed": 2, "needs_review": 1}, "items": [{"question": "Show monthly sales this year", "status": "passed"}, {"question": "Which region has the highest sales?", "status": "passed"}, {"question": "New customer repeat rate", "status": "needs_review"}]}


@app.get("/api/transformation-requests")
def list_transformation_requests(status: str | None = None, query: str | None = None):
    return transformation_service.list(status, query)


@app.post("/api/transformation-requests")
def create_transformation_request(body: TransformationRequestData):
    return transformation_service.create(body)


@app.get("/api/transformation-requests/{request_id}")
def get_transformation_request(request_id: str):
    return transformation_service.get(request_id)


@app.post("/api/transformation-requests/{request_id}/copy")
def copy_transformation_request(request_id: str):
    return transformation_service.copy(request_id)


@app.post("/api/transformation-requests/{request_id}/{action}")
def transition_transformation_request(request_id: str, action: str):
    if action not in {"submit", "demo-approve", "demo-succeed", "demo-fail"}:
        raise HTTPException(404, "Unknown transformation action.")
    return transformation_service.transition(request_id, action)


@app.post("/api/transformation-sql/generate")
def generate_transformation_sql(body: TransformationSQLGenerateRequest):
    catalog = get_metadata_provider("local").load_catalog({"path": str(settings.metadata_path)})
    return generation_service.generate(body, catalog)


# Serve the built frontend (single-image, same-origin hosting). Mounted last so
# every /api route above takes precedence; the SPA fallback (html=True) then
# serves index.html for any other path. Skipped when the build is absent (e.g.
# local dev, where Vite serves the UI on its own port).
_frontend_dist = Path(settings.frontend_dist)
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
