import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApprovalService } from '../../../core/approval-service';
import type { createFileToolsService } from './service';
import { FileToolsError } from './access';
export function createFileToolsRouter(
  service: ReturnType<typeof createFileToolsService>,
  approvals: ApprovalService,
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith('/api/file-tools/')) return false;
    const reply = (value: unknown, status = 200) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method === 'GET' && url.pathname.endsWith('/paths')) {
        reply({
          ok: true,
          items: await service.paths((url.searchParams.get('q') || '').slice(0, 2000)),
        });
        return true;
      }
      if (request.method === 'GET' && url.pathname.endsWith('/preview')) {
        const value = service.get(url.searchParams.get('plan') || '');
        const index = Number(url.searchParams.get('index'));
        const preview = value.previews.find((item) => item.index === index);
        if (!preview) throw new FileToolsError('This output preview is unavailable.');
        response.writeHead(200, {
          'Content-Type':
            (
              {
                '.pdf': 'application/pdf',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.csv': 'text/plain; charset=utf-8',
              } as Record<string, string>
            )[path.extname(preview.path).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Disposition': 'inline; filename="Preview' + path.extname(preview.path) + '"',
        });
        fs.createReadStream(preview.path)
          .on('error', () => response.destroy())
          .pipe(response);
        return true;
      }
      if (
        request.method !== 'POST' ||
        !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')
      )
        throw new FileToolsError('Use a JSON request.');
      let source = '';
      for await (const chunk of request) {
        source += chunk.toString();
        if (Buffer.byteLength(source) > 128_000)
          throw new FileToolsError('The request is too large.');
      }
      const body = JSON.parse(source);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new FileToolsError('Invalid file request.');
      switch (url.pathname) {
        case '/api/file-tools/daily':
          reply({ ok: true, plan: await service.daily(body.request) });
          break;
        case '/api/file-tools/grant':
          reply({ ok: true, grant: await service.grant(body.path) });
          break;
        case '/api/file-tools/inspect':
          reply({ ok: true, ...(await service.inspect(body.grants)) });
          break;
        case '/api/file-tools/prepare':
          reply({ ok: true, ...(await service.prepare(body)) });
          break;
        case '/api/file-tools/preview': {
          const payload = { planId: body.planId, selected: body.selected };
          if (
            !approvals.consume({ token: body.approvalToken, action: 'file-tools.preview', payload })
          )
            throw new FileToolsError(
              'Confirm these exact output previews before any conversion starts.',
            );
          reply({ ok: true, ...(await service.preview(body.planId, body.selected)) });
          break;
        }
        case '/api/file-tools/apply': {
          const payload = {
            planId: body.planId,
            selected: body.selected,
            cleanupAcknowledged: body.cleanupAcknowledged === true,
          };
          if (
            !approvals.consume({ token: body.approvalToken, action: 'file-tools.apply', payload })
          )
            throw new FileToolsError(
              'Review the plan and approve these exact changes before applying.',
            );
          reply({
            ok: true,
            ...(await service.apply(body.planId, body.selected, body.cleanupAcknowledged === true)),
          });
          break;
        }
        case '/api/file-tools/undo': {
          if (
            !approvals.consume({
              token: body.approvalToken,
              action: 'file-tools.undo',
              payload: { planId: body.planId },
            })
          )
            throw new FileToolsError('Undo requires a fresh approval.');
          reply(await service.undo(body.planId));
          break;
        }
        default:
          reply({ ok: false, error: 'File action unavailable.' }, 404);
      }
    } catch (error) {
      reply(
        {
          ok: false,
          error:
            error instanceof FileToolsError
              ? error.message
              : 'The selected files could not be accessed. Check permissions and try again.',
        },
        400,
      );
    }
    return true;
  };
}
