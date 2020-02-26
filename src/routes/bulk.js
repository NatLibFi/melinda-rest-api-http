/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda
*
* Copyright (C) 2018-2019 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-http
*
* melinda-rest-api-http program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-http is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import {Router} from 'express';
import HttpStatus from 'http-status';
import passport from 'passport';
import {v4 as uuid} from 'uuid';
import {Error, Utils} from '@natlibfi/melinda-commons';
import {OPERATIONS} from '@natlibfi/melinda-rest-api-commons';
import createService from '../interfaces/bulk';

export default async function (mongoUrl) {
	const {createLogger} = Utils;
	const logger = createLogger(); // eslint-disable-line no-unused-vars

	const CONTENT_TYPES = ['application/xml', 'application/marc', 'application/json', 'application/alephseq'];
	const OPERATION_TYPES = [OPERATIONS.CREATE, OPERATIONS.UPDATE];
	const Service = await createService(mongoUrl);

	return new Router()
		.use(passport.authenticate('melinda', {session: false}))
		.use(checkContentType)
		.post('/:operation', create)
		.get('/', doQuery)
		.get('/:id', readContent)
		.delete('/', remove)
		.delete('/:id', removeContent);

	async function create(req, res, next) { // eslint-disable-line no-unused-vars
		try {
			logger.log('debug', 'Bulk job');
			const params = {
				correlationId: uuid(),
				cataloger: req.user.id,
				operation: req.params.operation.toUpperCase(),
				contentType: req.headers['content-type'],
				recordLoadParams: req.query || null
			};

			logger.log('debug', 'Params done');
			if (params.operation && OPERATION_TYPES.includes(params.operation)) {
				const response = await Service.create(req, params);
				res.json(response);
				return;
			}

			logger.log('debug', 'Invalid operation');
			throw new Error(HttpStatus.BAD_REQUEST, 'Invalid operation');
		} catch (error) {
			next(error);
		}
	}

	function checkContentType(req, res, next) {
		if (req.headers['content-type'] === undefined || !CONTENT_TYPES.includes(req.headers['content-type'])) {
			logger.log('debug', 'Invalid content type');
			throw new Error(HttpStatus.NOT_ACCEPTABLE, 'Invalid content-type');
		}

		next();
	}

	async function doQuery(req, res, next) { // eslint-disable-line no-unused-vars
		const response = await Service.doQuery({cataloger: req.user.id, query: req.query});
		res.json(response);
	}

	/* Functions after this are here only to test purposes */
	async function readContent(req, res, next) { // eslint-disable-line no-unused-vars
		const {contentType, readStream} = await Service.readContent({cataloger: req.user.id, correlationId: req.params.id});
		res.set('content-type', contentType);
		readStream.pipe(res);
	}

	async function remove(req, res, next) { // eslint-disable-line no-unused-vars
		const response = await Service.remove({cataloger: req.user.id, correlationId: req.query.id});
		res.json({request: req.query, result: response});
	}

	async function removeContent(req, res, next) { // eslint-disable-line no-unused-vars
		await Service.removeContent({cataloger: req.user.id, correlationId: req.params.id});
		res.sendStatus(204);
	}
}
