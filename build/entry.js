// Entry point bundled into vendor/graphql-bundle.js.
// Exposes just the pieces of graphql-js the app needs, as a single global.
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isEnumType,
  isScalarType,
  isInputObjectType,
  isListType,
  isNonNullType,
  getNamedType,
} from "graphql";

window.GraphQLLib = {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isEnumType,
  isScalarType,
  isInputObjectType,
  isListType,
  isNonNullType,
  getNamedType,
};
