from __future__ import annotations

import logging
from threading import Event, Thread, local

from .jobs import claim


_consumer_state = local()


def execute_job(
    job_id: str | None = None, *, kinds: tuple[str, ...] | None = None,
    exclude_kinds: tuple[str, ...] = (), client_service: bool | None = None,
) -> bool:
    from .security_context import AccessDenied, actor_scope, auth_mode, has_actor_scope
    if auth_mode() == "oidc" and not has_actor_scope():
        from .identity import execution_actors
        from .db import database_path
        from .identity import identity_path
        actors = execution_actors()
        lane = (str(identity_path()), kinds, exclude_kinds, client_service)
        cursors = getattr(_consumer_state, "cursors", {})
        last = cursors.get(lane)
        keys = [(actor.tenant_id, actor.user_id) for actor in actors]
        start = (keys.index(last) + 1) % len(actors) if last in keys else 0
        for actor in actors[start:] + actors[:start]:
            try:
                with actor_scope(actor):
                    if database_path().is_file() and _execute_owned_job(
                        job_id, kinds=kinds, exclude_kinds=exclude_kinds, client_service=client_service,
                    ):
                        cursors[lane] = (actor.tenant_id, actor.user_id)
                        _consumer_state.cursors = cursors
                        return True
            except AccessDenied:
                continue  # Revoked between listing workspaces and claiming a job.
        return False
    return _execute_owned_job(job_id, kinds=kinds, exclude_kinds=exclude_kinds, client_service=client_service)


def _execute_owned_job(
    job_id: str | None = None, *, kinds: tuple[str, ...] | None = None,
    exclude_kinds: tuple[str, ...] = (), client_service: bool | None = None,
) -> bool:
    from .security_context import AccessDenied
    lease = claim(job_id, kinds=kinds, exclude_kinds=exclude_kinds, client_service=client_service)
    if lease is None:
        return False
    with lease:
        try:
            if lease.kind == "screening":
                from .screening_strategy_execution import execute
                execute(lease)
            elif lease.kind == "screening_task":
                from .screening_service import execute_task_run
                execute_task_run(lease)
            elif lease.kind == "research_scan":
                from .research_scan_service import execute_job as execute_scan_job
                execute_scan_job(lease)
            elif lease.kind == "research_turn":
                from .research_turn_service import execute_turn
                execute_turn(lease)
            elif lease.kind == "intelligence_source":
                from .intelligence import execute_source
                execute_source(lease)
            elif lease.kind == "research_pdf":
                from .research_pdf_service import execute_export
                execute_export(lease)
            elif lease.kind == "research_matrix":
                from .research_matrices import execute
                execute(lease)
            elif lease.kind == "report_evaluation":
                from .report_evaluation import execute
                execute(lease)
            elif lease.kind == "report_metadata":
                from .report_catalog import execute
                execute(lease)
            elif lease.kind == "data_sync":
                from .maintenance_service import refresh_data
                refresh_data(lease)
            elif lease.kind == "financial_probe":
                from .financial_probe import execute
                execute(lease)
            elif lease.kind == "financial_sync":
                from .financial_sync import execute
                execute(lease)
            elif lease.kind == "disclosure_import":
                from .disclosure_sync import execute
                execute(lease)
            else:
                lease.finish("failed", "未知任务类型")
        except AccessDenied:
            # The trusted permission change already cancelled this user's jobs.
            # Do not write a late result or retry using elevated credentials.
            return True
        except Exception as exc:
            logging.getLogger(__name__).exception("Job failed: %s", lease.id)
            try:
                lease.finish("failed", f"后台任务执行失败：{type(exc).__name__}；请检查数据和固定版本引用后重试")
            except AccessDenied:
                return True
    return True


def execute_screening(job_id: str) -> None:
    execute_job(job_id)


def execute_report_evaluation(job_id: str) -> None:
    execute_job(job_id)


def run_worker(poll_seconds: float = 1.0, *, stop_event: Event | None = None) -> None:
    stop = stop_event if stop_event is not None else Event()

    def consume(*, kinds=None, exclude_kinds=(), client_service=None):
        while not stop.is_set():
            try:
                if not execute_job(kinds=kinds, exclude_kinds=exclude_kinds, client_service=client_service):
                    stop.wait(poll_seconds)
            except Exception:
                logging.getLogger(__name__).exception("Worker lane failed")
                stop.wait(poll_seconds)

    def schedule_periodic_tasks():
        from . import client_service, client_service_archive, news_retention
        while not stop.is_set():
            for tick in (client_service.scheduler_tick, news_retention.scheduler_tick, client_service_archive.scheduler_tick):
                try:
                    tick()
                except Exception:
                    logging.getLogger(__name__).exception("Periodic scheduler failed: %s", tick.__module__)
            stop.wait(20)

    # Reserve one slot for each group and let either group use the third.
    # Codex turns can wait for scans, so scans run on a separate consumer.
    consumers = (
        ("research-turn-worker", {"client_service": False}),
        ("client-service-worker", {"client_service": True}),
        ("shared-turn-worker", {"kinds": ("research_turn",)}),
        ("research-pdf-worker", {"kinds": ("research_pdf",)}),
        ("research-matrix-worker", {"kinds": ("research_matrix",)}),
        ("intelligence-source-worker", {"kinds": ("intelligence_source",)}),
    )
    threads = [Thread(target=consume, kwargs=options, name=name, daemon=True) for name, options in consumers]
    threads.append(Thread(target=schedule_periodic_tasks, name="periodic-task-scheduler", daemon=True))
    for thread in threads:
        thread.start()
    try:
        consume(exclude_kinds=("research_turn", "research_pdf", "research_matrix", "intelligence_source"))
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=2)


if __name__ == "__main__":
    from .db import init_db

    from .security_context import auth_mode, actor_scope, LOCAL_ACTOR
    if auth_mode() == "oidc":
        from dataclasses import replace
        from .identity import initialize
        initialize()
        with actor_scope(replace(LOCAL_ACTOR, maintenance=True)):
            init_db()
    else:
        init_db()
    run_worker()
