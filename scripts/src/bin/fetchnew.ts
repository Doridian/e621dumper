import { Client } from '@elastic/elasticsearch';
import * as request from 'request-promise';
import { readFileSync, writeFileSync } from 'fs';
import { TagType, APIPost, APINestedTags, ESPost, TagClass, tagTypeMap, PostDate } from '../lib/types';

const config = require('../../config.json');
const MAX_ID_PATH = `${__dirname}/e621posts.maxid`;
const client = new Client(config.elasticsearch);

interface PostPage {
	items: ESPost[];
	minId: number;
	maxId: number;
}

interface ESBulkOperation {
	update: {
		_id: string;
		_index: 'e621posts';
		retry_on_conflict: number;
	};
}

interface ESPostDoc {
	doc_as_upsert: true;
	doc: ESPost;
}

type ESQueueEntry = ESPostDoc | ESBulkOperation;

function fixArray(a?: string[] | string, s: string = ' ') {
	if (a) {
		if (typeof a === 'string') {
			a = a.split(s);
		}
		return Array.from(new Set(a));
	}
	return [];
}

function fixTags(v: ESPost | APIPost, name: TagClass) {
	const a = v[name];
	v[name] = [];
	for (const typ of tagTypeMap) {
		(v as any)[`${name}_${typ}`] = [];
	}
	if (!a) {
		return;
	}

	if ((a as string[] | string).length) {
		v[name] = fixArray(<string[] | string>a, ' ');
		return;
	}

	for (const typ of <TagType[]>Object.keys(a)) {
		fixTagsSub((a as APINestedTags)[typ]!, v, `${name}_${typ}`, name);
	}
}

function fixTagsSub(a: string[], v: APIPost | ESPost, name: string, gname: TagClass) {
	a = fixArray(a, ' ');

	for(const t of a) {
		((v as any)[name] as string[]).push(t);
		(v[gname] as string[]).push(t);
	}
}

function normalizer(v: APIPost | ESPost): ESPost {
	// Uniq sources
	const s = v.sources || [];
	if (v.source) {
	        s.push(v.source);
	}
	delete v.source;
	const sU = new Set(s);
	v.sources = Array.from(sU);

	fixTags(v, 'tags');
	fixTags(v, 'locked_tags');

	// Fix arrays that are just strings...
	v.children = fixArray(v.children, ',');

	// Fix date
	const d = v.created_at as PostDate;
	v.created_at = new Date((d.s * 1000) + (d.n / 1000000)).toISOString();

	return v as ESPost;
}

async function getPage(beforeId?: number): Promise<PostPage> {
	const res = await request('https://e621.net/post/index.json?limit=320&typed_tags=1' + (beforeId ? `&before_id=${beforeId}` : ''), {
		headers: { 'User-Agent': 'e621updater (Doridian)' },
	});
	const body = JSON.parse(res);
	const items = body.map((v: APIPost) => normalizer(v));

	let minId = items[0].id, maxId = items[0].id;
	for (const item of items) {
		const id = item.id;
		if (id < minId) {
			minId = id;
		}
		if (id > maxId) {
			maxId = id;
		}
	}

	return {
		items,
		minId,
		maxId,
	};
}

async function main() {
	let maxId = -1;
	try {
		maxId = parseInt(readFileSync(MAX_ID_PATH).toString('utf8'));
	} catch { }

	if (maxId <= 0) {
		const maxIdRes = await client.search({
			index: 'e621posts',
			body: {
				aggs: {
					max_id: {
						max: {
							field: 'id',
						},
					},
				},
			},
		});
		maxId = maxIdRes.body.aggregations.max_id.value;
	}

	console.log(`Starting with maxId = ${maxId}`);

	let _maxId = maxId;

	let beforeId = undefined;
	while (true) {
		console.log(`Asking with beforeId = ${beforeId}`);
		const data: PostPage = await getPage(beforeId);

		const pageQueue: ESQueueEntry[] = [];

		if (data.maxId > _maxId) {
			_maxId = data.maxId;
		}

		for (const item of data.items) {
			pageQueue.push({
				update: {
					_id: item.id.toString(10),
					_index : 'e621posts',
					retry_on_conflict: 3,
				},
			});
			pageQueue.push({
				doc: item,
				doc_as_upsert: true,
			});
		}

		const result = await client.bulk({
			body: pageQueue,
		});

		if (result.body.errors) {
			throw new Error(result.body);
		}

		if (data.minId <= maxId) {
			console.log('Done!');
			break;
		}
		beforeId = data.minId;
	}

	writeFileSync(MAX_ID_PATH, _maxId);
}

async function safeMain() {
	try {
		await main();
	} catch(e) {
		console.error(e);
		process.exit(1);
	}
}

safeMain();